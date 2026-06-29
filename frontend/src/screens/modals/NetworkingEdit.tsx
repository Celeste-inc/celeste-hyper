import { useEffect, useState } from "react";
import { http } from "../../shared/api/client";
import type { NetworkingService } from "../../shared/types/api";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";
import { apiError } from "../../shared/utils/format";

export function NetworkingEdit({ name, notify, closeModal, load }: ModalActions & { name: string }) {
  const [current, setCurrent] = useState<NetworkingService | null>(null);
  const [type, setType] = useState<"ClusterIP" | "NodePort" | "LoadBalancer">("ClusterIP");
  const [port, setPort] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [nodePort, setNodePort] = useState("");
  const [externalIPs, setExternalIPs] = useState("");
  const [suggestedIPs, setSuggestedIPs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void http.networking(name).then((res) => {
      const svc = res.status === 200 ? res.body.service : null;
      setCurrent(svc);
      if (svc) {
        const realType = (svc.type as "ClusterIP" | "NodePort" | "LoadBalancer") ?? "ClusterIP";
        setType(realType);
        const first = svc.ports?.[0];
        if (first) {
          setPort(String(first.port));
          setTargetPort(first.targetPort === null || first.targetPort === undefined ? "" : String(first.targetPort));
          setNodePort(first.nodePort != null ? String(first.nodePort) : "");
        }
        setExternalIPs((svc.externalIPs ?? []).join("\n"));
        // Pull candidate IPs from the existing endpoints — anything that's a NodePort URL contains the
        // node's IP and is reachable from the operator's network. Dedup + filter junk.
        const seen = new Set<string>();
        for (const ep of svc.endpoints ?? []) {
          const m = ep.url.match(/^https?:\/\/([^:/]+)/);
          if (!m) continue;
          const host = m[1]!;
          if (host === "localhost" || host === "127.0.0.1" || host.startsWith("10.43.")) continue; // skip k8s ClusterIPs
          if (seen.has(host)) continue;
          seen.add(host);
        }
        setSuggestedIPs([...seen]);
      }
    });
  }, [name]);

  const save = async () => {
    setBusy(true);
    setInfo(null);
    const body: Parameters<typeof http.patchNetworking>[1] = {};
    if (port) body.port = Number(port);
    if (targetPort) {
      const asNum = Number(targetPort);
      body.targetPort = Number.isFinite(asNum) && String(asNum) === targetPort ? asNum : targetPort;
    }
    body.type = type;
    if (type !== "ClusterIP" && nodePort) body.nodePort = Number(nodePort);
    // externalIPs is an explicit field (one per line, blank lines ignored). When the textarea is
    // entirely empty, send [] to wipe the stored list — the patch builder translates that to null.
    body.externalIPs = externalIPs.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const res = await http.patchNetworking(name, body);
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    setInfo(res.body.loadBalancer.message);
    notify(t("Networking updated"));
    await load();
  };

  return (
    <>
      <h2 className="dialog-title">{t("Networking")}: <code>{name}</code></h2>
      <p className="dialog-description">
        {t("Ajustes feitos sem recriar o workload — pods rolam um a um, dados persistentes ficam intactos. O LB nativo (kube-proxy) repassa a nova porta para todas as réplicas via selector app=") + name + "."}
      </p>
      {current ? (
        <p className="dialog-description">
          {t("Atual")}: <Pill tone="acc">{current.type}</Pill> · <Tag>:{current.ports?.[0]?.port ?? "—"}</Tag>
          {current.ports?.[0]?.nodePort ? <> → <Tag>NodePort {current.ports[0].nodePort}</Tag></> : null}
        </p>
      ) : null}

      <SelectField
        id="net-type"
        label={t("Service type (LB nativo)")}
        value={type}
        onChange={(v) => setType(v as typeof type)}
        options={[
          { value: "ClusterIP", label: "ClusterIP — só dentro do cluster" },
          { value: "NodePort", label: "NodePort — expõe na rede dos nós (30000-32767)" },
          { value: "LoadBalancer", label: "LoadBalancer — cloud LB se disponível" },
        ]}
      />
      <Field id="net-port" label={t("Service port (a porta visível para clientes)")} value={port} onChange={setPort} placeholder="ex: 80" />
      <Field id="net-target" label={t("Target port (containerPort no pod)")} value={targetPort} onChange={setTargetPort} placeholder={t("número ou nome da porta nomeada")} />
      {type !== "ClusterIP" ? (
        <>
          <Field id="net-node" label={t("NodePort (30000-32767, deixe em branco para auto)")} value={nodePort} onChange={setNodePort} />
          <p className="text-[var(--mut)]" style={{ fontSize: 12, marginTop: -4 }}>
            {t("Limite do kube-apiserver. Para expor numa porta arbitrária (ex: 80, 8090) na sua rede, use External IPs abaixo.")}
          </p>
        </>
      ) : null}

      <Field
        id="net-extips"
        label={t("External IPs (um por linha, opcional)")}
        value={externalIPs}
        onChange={setExternalIPs}
        placeholder={suggestedIPs.length ? suggestedIPs.join("\n") : t("ex: 192.168.0.42 (descubra com: kubectl get nodes -o wide)")}
        multiline
      />
      <p className="text-[var(--mut)]" style={{ fontSize: 12, marginTop: -4 }}>
        {t("kube-proxy faz cada node escutar na Service port nessas IPs — funciona com qualquer porta (80, 8090, etc), sem o limite do NodePort. Deixe em branco para desativar.")}
        {suggestedIPs.length ? (
          <>
            {" "}
            <strong>{t("Sugestões do cluster")}:</strong> {suggestedIPs.map((ip) => (
              <button
                key={ip}
                type="button"
                className="ip-suggestion"
                style={{ background: "transparent", border: "1px solid var(--mut)", borderRadius: 4, padding: "1px 6px", margin: "0 4px", cursor: "pointer", fontSize: 11 }}
                onClick={() => setExternalIPs((curr) => (curr.includes(ip) ? curr : (curr ? curr + "\n" : "") + ip))}
              >
                {ip}
              </button>
            ))}
          </>
        ) : null}
      </p>

      {info ? <p className="text-[var(--mut)]" style={{ fontSize: 12 }}>{info}</p> : null}

      <div className="dialog-actions justify-between">
        <AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton>
        <AppButton onClick={save} disabled={busy}>{busy ? t("Saving…") : t("Apply networking changes")}</AppButton>
      </div>
    </>
  );
}
