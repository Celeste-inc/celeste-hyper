import { useEffect, useState } from "react";
import { http } from "../../shared/api/client";
import type { Cluster, RegistrySourceSummary, Template } from "../../shared/types/api";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";
import { apiError } from "../../shared/utils/format";

interface DeployStreamFrame {
  status: string;
  message: string | null;
}

interface Props extends ModalActions {
  templateId: string;
  /** When templateId === "custom", the image ref to deploy (from a Docker Hub search hit). */
  image?: string;
  clusters: Cluster[];
}

export function TemplateDeploy({ templateId, image, clusters, notify, closeModal, load }: Props) {
  const isCustom = templateId === "custom";
  const [tpl, setTpl] = useState<Template | null>(null);
  const [registries, setRegistries] = useState<RegistrySourceSummary[]>([]);
  const [registrySourceId, setRegistrySourceId] = useState("");
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? "");
  const [tag, setTag] = useState("");
  const [replicas, setReplicas] = useState("2");
  const [serviceType, setServiceType] = useState<"ClusterIP" | "NodePort" | "LoadBalancer">("ClusterIP");
  const [autoscale, setAutoscale] = useState(false);
  const [hpaMin, setHpaMin] = useState("2");
  const [hpaMax, setHpaMax] = useState("10");
  const [hpaCpu, setHpaCpu] = useState("70");
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [customPort, setCustomPort] = useState("80");
  const [customEnvText, setCustomEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [deployedId, setDeployedId] = useState<number | null>(null);
  const [streamLines, setStreamLines] = useState<DeployStreamFrame[]>([]);
  const [appliedKinds, setAppliedKinds] = useState<string[]>([]);
  const [lbMessage, setLbMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isCustom) {
      // No catalog lookup; default tag is "latest", default port 80 — both editable below.
      setTag("latest");
      // Default a reasonable name from the image tail (e.g. "library/nginx" → "nginx").
      if (image && !name) {
        const slug = image.split("/").pop()?.replace(/[^a-z0-9-]/g, "-") ?? "";
        if (slug) setName(slug);
      }
    } else {
      void http.templates().then((res) => {
        if (res.status !== 200) return;
        const match = res.body.items.find((item) => item.id === templateId) ?? null;
        setTpl(match);
        if (match) {
          setTag(match.defaultTag);
          if (match.recommendedAutoscale) {
            setHpaMin(String(match.recommendedAutoscale.minReplicas));
            setHpaMax(String(match.recommendedAutoscale.maxReplicas));
            setHpaCpu(String(match.recommendedAutoscale.targetCPUUtilizationPercentage));
          }
        }
      });
    }
    void http.registrySources().then((res) => {
      if (res.status === 200) setRegistries(res.body.items);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, image, isCustom]);

  useEffect(() => {
    if (deployedId === null) return;
    const es = new EventSource(`/api/deployments/${deployedId}/stream`);
    es.addEventListener("status", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as DeployStreamFrame;
        setStreamLines((prev) => [...prev, parsed]);
      } catch {
        // ignore
      }
    });
    es.addEventListener("end", () => es.close());
    es.onerror = () => es.close();
    return () => es.close();
  }, [deployedId]);

  const deploy = async () => {
    if (!tpl && !isCustom) return;
    setBusy(true);
    // For custom deploys: parse KEY=value pairs from the textarea, one per line.
    let envForCustom: Record<string, string> | undefined;
    if (isCustom && customEnvText.trim()) {
      envForCustom = {};
      for (const line of customEnvText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        envForCustom[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
      }
    }
    const body: Parameters<typeof http.deployTemplate>[0] = {
      templateId: isCustom ? "custom" : tpl!.id,
      name: name.trim(),
      namespace: namespace.trim(),
      clusterId,
      replicas: Number(replicas),
      tag: tag.trim() || undefined,
      serviceType,
      env: isCustom ? envForCustom : (Object.keys(envValues).length ? envValues : undefined),
      autoscale: autoscale
        ? { minReplicas: Number(hpaMin), maxReplicas: Number(hpaMax), targetCPUUtilizationPercentage: Number(hpaCpu) }
        : undefined,
      registrySourceId: registrySourceId || undefined,
      customImage: isCustom ? image : undefined,
      customPort: isCustom ? Number(customPort) : undefined,
    };
    const res = await http.deployTemplate(body);
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    setDeployedId(res.body.deploymentId);
    setAppliedKinds(res.body.applied.map((a) => a.kind));
    setLbMessage(res.body.loadBalancer.message);
    notify(t("Template deployed"));
    await load();
  };

  if (!tpl && !isCustom) {
    return (
      <>
        <h2 className="dialog-title">{t("Loading template…")}</h2>
        <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
      </>
    );
  }

  if (deployedId !== null) {
    return (
      <>
        <h2 className="dialog-title">{t("Deploying")}: <code>{name}</code></h2>
        <p className="dialog-description">
          {appliedKinds.map((k) => <Tag key={k}>{k}</Tag>)}
        </p>
        {lbMessage ? (
          <p className="text-[var(--mut)]" style={{ fontSize: 12 }}>{lbMessage}</p>
        ) : null}
        <h4 className="detail-subtitle">{t("Live deploy")}</h4>
        <ul className="detail-list" aria-label={t("Deploy stream")}>
          {streamLines.length === 0 ? (
            <li><span className="text-[var(--mut)]">{t("Waiting for status…")}</span></li>
          ) : streamLines.map((line, i) => (
            <li key={i}><Tag>{line.status}</Tag>{line.message ? <span>{line.message}</span> : null}</li>
          ))}
        </ul>
        <div className="dialog-actions"><AppButton onClick={closeModal}>{t("Close")}</AppButton></div>
      </>
    );
  }

  return (
    <>
      <h2 className="dialog-title">
        {isCustom ? `${t("Deploy custom image")}: ` : `${t("Deploy template")}: `}{tpl ? tpl.label : image}
      </h2>
      <p className="dialog-description">
        <Tag>{tpl ? tpl.image : image}</Tag>
        {tpl ? <> · <Pill tone="acc">{tpl.category}</Pill></> : <> · <Pill tone="acc">{t("custom")}</Pill></>}
        <br />
        <span className="text-[var(--mut)]" style={{ fontSize: 12 }}>
          {tpl ? tpl.description : t("Imagem do Docker Hub. Confirme nome, namespace, porta e replicas antes de deployar.")}
        </span>
      </p>

      <div className="template-deploy-grid">
        <Field id="td-name" label={t("Service name")} value={name} onChange={setName} placeholder="my-app" />
        <Field id="td-ns" label={t("Namespace")} value={namespace} onChange={setNamespace} />
        <SelectField
          id="td-cluster"
          label={t("Cluster")}
          value={clusterId}
          onChange={setClusterId}
          options={clusters.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Field id="td-tag" label={t("Image tag")} value={tag} onChange={setTag} placeholder={tpl ? tpl.defaultTag : "latest"} />
        <Field id="td-rep" label={t("Replicas")} value={replicas} onChange={setReplicas} />
        {isCustom ? (
          <Field id="td-cport" label={t("Container port")} value={customPort} onChange={setCustomPort} placeholder="80" />
        ) : null}
      </div>
      {isCustom ? (
        <Field
          id="td-cenv"
          label={t("Environment (KEY=value, uma por linha)")}
          value={customEnvText}
          onChange={setCustomEnvText}
          placeholder={"PORT=80\nNODE_ENV=production"}
          multiline
        />
      ) : null}

      <SelectField
        id="td-reg"
        label={t("Registry (optional — only for private images)")}
        value={registrySourceId}
        onChange={setRegistrySourceId}
        options={[
          { value: "", label: t("None — public image") },
          ...registries.map((r) => ({ value: r.id, label: `${r.name} (${r.presetId})` })),
        ]}
      />

      <SelectField
        id="td-svc"
        label={t("Service type (native LB)")}
        value={serviceType}
        onChange={(v) => setServiceType(v as typeof serviceType)}
        options={[
          { value: "ClusterIP", label: "ClusterIP — in-cluster LB" },
          { value: "NodePort", label: "NodePort — expose on every node" },
          { value: "LoadBalancer", label: "LoadBalancer — cloud LB if available" },
        ]}
      />

      {tpl && tpl.env.length ? <h4 className="detail-subtitle">{t("Environment")}</h4> : null}
      {tpl ? (
        <div className="template-deploy-grid">
          {tpl.env.map((e) => (
            <Field
              key={e.key}
              id={`td-env-${e.key}`}
              label={`${e.key}${e.required ? " *" : ""}${e.secret ? " (secret)" : ""}`}
              value={envValues[e.key] ?? e.default ?? ""}
              onChange={(v) => setEnvValues((prev) => ({ ...prev, [e.key]: v }))}
              placeholder={e.description}
            />
          ))}
        </div>
      ) : null}

      <label className="settings-check" htmlFor="td-autoscale">
        <input id="td-autoscale" type="checkbox" checked={autoscale} onChange={(e) => setAutoscale(e.target.checked)} />
        <span>{t("Enable autoscaling (HPA)")}<br /><span className="text-[11px] text-[var(--mut)]">{t("Hyper provisions a HorizontalPodAutoscaler. The Service (LB) automatically routes to new pods as they come up.")}</span></span>
      </label>
      {autoscale ? (
        <div className="template-deploy-grid hpa-fields">
          <Field id="td-min" label={t("Min replicas")} value={hpaMin} onChange={setHpaMin} />
          <Field id="td-max" label={t("Max replicas")} value={hpaMax} onChange={setHpaMax} />
          <Field id="td-cpu" label={t("Target CPU %")} value={hpaCpu} onChange={setHpaCpu} />
        </div>
      ) : null}

      <div className="dialog-actions justify-between">
        <AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton>
        <AppButton disabled={busy || !name.trim() || !clusterId} onClick={deploy}>
          {busy ? t("Deploying…") : t("Deploy")}
        </AppButton>
      </div>
    </>
  );
}
