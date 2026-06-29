import { useEffect, useState } from "react";
import type { ExposeConfig, R2Source, Service } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";

export function Settings({ name, notify, closeModal, setModal, load }: ModalActions & { name: string }) {
  const [service, setService] = useState<Service | null>(null);
  const [namespace, setNamespace] = useState("");
  const [r2Sources, setR2Sources] = useState<R2Source[]>([]);
  const [r2SourceId, setR2SourceId] = useState("default");
  const [r2Prefix, setR2Prefix] = useState("");
  const [imageRef, setImageRef] = useState("");
  const [containerName, setContainerName] = useState("");
  const [imagePullSecret, setImagePullSecret] = useState("");
  const [autoRollback, setAutoRollback] = useState(false);
  const [autoRedeployOnEnv, setAutoRedeployOnEnv] = useState(false);
  const [exposeEnabled, setExposeEnabled] = useState(false);
  const [exposeType, setExposeType] = useState<ExposeConfig["type"]>("ClusterIP");
  const [exposePort, setExposePort] = useState("");
  const [exposeTargetPort, setExposeTargetPort] = useState("");
  const [exposeNodePort, setExposeNodePort] = useState("");
  const [helmRelease, setHelmRelease] = useState("");
  const [helmChartRef, setHelmChartRef] = useState("");
  const [helmImageTagValuePath, setHelmImageTagValuePath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitPath, setGitPath] = useState("");
  const [deployKeyPath, setDeployKeyPath] = useState("");

  useEffect(() => {
    void http.r2Sources().then((result) => setR2Sources(result.body.items || []));
    void http.service(name).then((result) => {
      const item = result.body.service;
      if (!item) return;
      setService(item);
      setNamespace(item.namespace);
      setAutoRollback(Boolean(item.autoRollback));
      setAutoRedeployOnEnv(Boolean(item.autoRedeployOnEnv));
      if (item.expose) {
        setExposeEnabled(true);
        setExposeType(item.expose.type);
        setExposePort(String(item.expose.port));
        setExposeTargetPort(item.expose.targetPort === undefined ? "" : String(item.expose.targetPort));
        setExposeNodePort(item.expose.nodePort === undefined ? "" : String(item.expose.nodePort));
      }
      if (item.sourceType === "r2-bundle") {
        setR2SourceId(item.r2SourceId || "default");
        setR2Prefix(item.r2Prefix);
      }
      if (item.sourceType === "registry-pull") {
        setImageRef(item.imageRef);
        setContainerName(item.containerName || "");
        setImagePullSecret(item.imagePullSecret || "");
        setHelmRelease(item.helmRelease || "");
        setHelmChartRef(item.helmChartRef || "");
        setHelmImageTagValuePath(item.helmImageTagValuePath || "");
      }
      if (item.sourceType === "git-sync") {
        setGitUrl(item.gitUrl);
        setGitRef(item.gitRef);
        setGitPath(item.gitPath);
        setDeployKeyPath(item.deployKeyPath || "");
      }
    });
  }, [name]);

  if (!service) return <><h2 className="dialog-title">{name} {t("settings")}</h2><p className="text-[var(--mut)]">{t("Loading...")}</p></>;

  const buildExpose = (): ExposeConfig | undefined => {
    if (!exposeEnabled) return undefined;
    const port = Number.parseInt(exposePort, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      notify(t("Expose: port must be 1..65535"), "bad");
      return null as unknown as undefined; // signals validation error to caller
    }
    const trimmedTarget = exposeTargetPort.trim();
    let targetPort: number | string | undefined;
    if (trimmedTarget !== "") {
      const asNum = Number.parseInt(trimmedTarget, 10);
      targetPort = String(asNum) === trimmedTarget ? asNum : trimmedTarget; // named container port stays as string
    }
    let nodePort: number | undefined;
    if (exposeType === "NodePort" && exposeNodePort.trim() !== "") {
      const np = Number.parseInt(exposeNodePort, 10);
      if (!Number.isFinite(np) || np < 30000 || np > 32767) {
        notify(t("Expose: nodePort must be 30000..32767"), "bad");
        return null as unknown as undefined;
      }
      nodePort = np;
    }
    return { type: exposeType, port, targetPort, nodePort, protocol: "TCP" };
  };

  const save = async () => {
    const expose = buildExpose();
    if (exposeEnabled && expose === (null as unknown as undefined)) return; // validation already notified
    const common = { autoRedeployOnEnv, ...(exposeEnabled ? { expose } : {}) };
    const patch = service.sourceType === "r2-bundle"
      ? { sourceType: service.sourceType, namespace, r2SourceId, r2Prefix, ...common }
      : service.sourceType === "git-sync"
      ? { sourceType: service.sourceType, namespace, gitUrl, gitRef, gitPath, deployKeyPath: deployKeyPath || undefined, ...common }
      : { sourceType: service.sourceType, namespace, imageRef, containerName: containerName || undefined, imagePullSecret: imagePullSecret || undefined, autoRollback, helmRelease: helmRelease || undefined, helmChartRef: helmChartRef || undefined, helmImageTagValuePath: helmImageTagValuePath || undefined, ...common };
    const result = await http.updateService(name, patch);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    closeModal();
    notify(t("Changes saved"));
    await load();
  };

  const remove = () => {
    setModal({ type: "service-delete", name });
  };

  return (
    <>
      <h2 className="dialog-title">{name} {t("settings")}</h2>
      <p className="dialog-description"><Pill tone="acc">{service.sourceType}</Pill></p>
      <Field id="e-ns" label={t("Namespace")} value={namespace} onChange={setNamespace} />
      {service.sourceType === "r2-bundle" ? <><SelectField id="e-r2source" label={t("R2 source")} value={r2SourceId} options={r2SourceOptions(r2Sources)} onChange={setR2SourceId} /><Field id="e-r2" label={t("R2 prefix")} value={r2Prefix} onChange={setR2Prefix} /></> : service.sourceType === "git-sync" ? (
        <>
          <Field id="e-giturl" label={t("Git URL")} value={gitUrl} onChange={setGitUrl} />
          <Field id="e-gitref" label={t("Git ref")} value={gitRef} onChange={setGitRef} />
          <Field id="e-gitpath" label={t("Git path")} value={gitPath} placeholder={t("k8s — repo-relative manifest dir")} onChange={setGitPath} />
          <Field id="e-gitkey" label={t("Deploy key path")} value={deployKeyPath} placeholder={t("filename under the server git-keys dir")} onChange={setDeployKeyPath} />
        </>
      ) : (
        <>
          <Field id="e-imgref" label={t("Image reference")} value={imageRef} onChange={setImageRef} />
          <Field id="e-container" label={t("Container name")} value={containerName} onChange={setContainerName} />
          <Field id="e-pull" label={t("Image pull secret")} value={imagePullSecret} onChange={setImagePullSecret} />
          <Field id="e-helmrel" label={t("Helm release")} value={helmRelease} onChange={setHelmRelease} />
          <Field id="e-helmchart" label={t("Helm chart ref")} value={helmChartRef} onChange={setHelmChartRef} />
          <Field id="e-helmpath" label={t("Helm image-tag values path")} value={helmImageTagValuePath} placeholder={t("image.tag or app.image.tag")} onChange={setHelmImageTagValuePath} />
          <label className="settings-check" htmlFor="e-autorollback">
            <input id="e-autorollback" type="checkbox" checked={autoRollback} onChange={(e) => setAutoRollback(e.target.checked)} />
            <span>{t("Auto-rollback on a failed health gate")}<br /><span className="text-[11px] text-[var(--mut)]">{t("When a deploy fails its health gate, automatically roll back to the previous version after a short grace window.")}</span></span>
          </label>
        </>
      )}
      <label className="settings-check" htmlFor="e-autoredeploy">
        <input id="e-autoredeploy" type="checkbox" checked={autoRedeployOnEnv} onChange={(e) => setAutoRedeployOnEnv(e.target.checked)} />
        <span>{t("Auto-redeploy when env changes")}<br /><span className="text-[11px] text-[var(--mut)]">{t("Saving config.env or secret.env enqueues a redeploy at the current tag.")}</span></span>
      </label>
      <label className="settings-check" htmlFor="e-expose">
        <input id="e-expose" type="checkbox" checked={exposeEnabled} onChange={(e) => setExposeEnabled(e.target.checked)} />
        <span>{t("Expose with a managed Service")}<br /><span className="text-[11px] text-[var(--mut)]">{t("Hyper applies a v1/Service in front of the workload (selector app=<name>). Operator-authored Services in the bundle are unaffected.")}</span></span>
      </label>
      {exposeEnabled ? (
        <>
          <SelectField id="e-expose-type" label={t("Service type")} value={exposeType} options={[{ value: "ClusterIP", label: "ClusterIP" }, { value: "NodePort", label: "NodePort" }, { value: "LoadBalancer", label: "LoadBalancer" }]} onChange={(value) => setExposeType(value as ExposeConfig["type"])} />
          <Field id="e-expose-port" label={t("Port")} value={exposePort} placeholder={t("e.g. 3001")} onChange={setExposePort} />
          <Field id="e-expose-target" label={t("Target port (optional)")} value={exposeTargetPort} placeholder={t("Container port number or named port (e.g. http)")} onChange={setExposeTargetPort} />
          {exposeType === "NodePort" ? <Field id="e-expose-nodeport" label={t("NodePort (optional)")} value={exposeNodePort} placeholder={t("30000..32767, leave blank to auto-allocate")} onChange={setExposeNodePort} /> : null}
        </>
      ) : null}
      <div className="dialog-actions justify-between"><AppButton variant="danger" onClick={remove}>{t("Remove service")}</AppButton><div className="flex gap-2"><AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton><AppButton onClick={save}>{t("Save changes")}</AppButton></div></div>
    </>
  );
}

function r2SourceOptions(sources: R2Source[]) {
  if (sources.length === 0) return [{ value: "default", label: "default" }];
  return sources.map((source) => ({ value: source.id, label: `${source.name} (${source.bucket})` }));
}
