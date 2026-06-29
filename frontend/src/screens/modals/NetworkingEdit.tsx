import { useEffect, useState } from "react";
import { CheckCircle2, Info, Network, Route, Server } from "lucide-react";
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

  const currentPort = current?.ports?.[0];
  const typeDescription = type === "ClusterIP"
    ? t("Acessível somente por outros workloads dentro do cluster.")
    : type === "NodePort"
      ? t("Expõe o serviço em todos os nós usando uma porta entre 30000 e 32767.")
      : t("Solicita um load balancer ao provedor de infraestrutura do cluster.");

  return (
    <div className="network-editor">
      <header className="network-editor-header">
        <span className="network-editor-icon" aria-hidden="true"><Network size={21} /></span>
        <div>
          <span className="network-editor-eyebrow">{t("Service networking")}</span>
          <h2 className="dialog-title">{t("Edit networking")}</h2>
          <p>{t("Configure como o tráfego chega ao serviço sem recriar o workload ou alterar dados persistentes.")}</p>
        </div>
      </header>

      {current ? (
        <section className="network-current" aria-label={t("Current networking configuration")}>
          <div className="network-current-title">
            <span><Server size={15} /></span>
            <div><small>{t("Current configuration")}</small><strong>{name}</strong></div>
          </div>
          <dl>
            <div><dt>{t("Type")}</dt><dd><Pill tone="acc">{current.type}</Pill></dd></div>
            <div><dt>{t("Service port")}</dt><dd><Tag>:{currentPort?.port ?? "—"}</Tag></dd></div>
            <div><dt>{t("Target port")}</dt><dd><Tag>{currentPort?.targetPort ?? "—"}</Tag></dd></div>
            {currentPort?.nodePort ? <div><dt>NodePort</dt><dd><Tag>:{currentPort.nodePort}</Tag></dd></div> : null}
          </dl>
        </section>
      ) : null}

      <section className="network-section">
        <header>
          <span aria-hidden="true"><Route size={16} /></span>
          <div><h3>{t("Traffic routing")}</h3><p>{t("Defina o tipo de exposição e o mapeamento entre cliente e container.")}</p></div>
        </header>
        <div className="network-section-body">
          <SelectField
            id="net-type"
            label={t("Service type")}
            hint={typeDescription}
            value={type}
            onChange={(v) => setType(v as typeof type)}
            options={[
              { value: "ClusterIP", label: "ClusterIP — somente dentro do cluster" },
              { value: "NodePort", label: "NodePort — acesso pela rede dos nós" },
              { value: "LoadBalancer", label: "LoadBalancer — balanceador do provedor" },
            ]}
          />
          <div className="network-port-grid">
            <Field id="net-port" label={t("Service port")} hint={t("Porta visível para os clientes.")} value={port} onChange={setPort} placeholder="80" />
            <Field id="net-target" label={t("Target port")} hint={t("Porta numérica ou nomeada no container.")} value={targetPort} onChange={setTargetPort} placeholder="8080 ou http" />
            {type !== "ClusterIP" ? (
              <Field id="net-node" label="NodePort" hint={t("Opcional. Em branco, o Kubernetes escolhe automaticamente.")} value={nodePort} onChange={setNodePort} placeholder="30000–32767" />
            ) : null}
          </div>
          {type !== "ClusterIP" ? (
            <div className="network-note"><Info size={15} /><span>{t("Para expor uma porta arbitrária na rede local, como 80 ou 8090, use External IPs abaixo.")}</span></div>
          ) : null}
        </div>
      </section>

      <section className="network-section">
        <header>
          <span aria-hidden="true"><Network size={16} /></span>
          <div><h3>{t("External access")}</h3><p>{t("Opcionalmente, faça os nós responderem por IPs específicos da sua rede.")}</p></div>
        </header>
        <div className="network-section-body">
          <div className="network-external-field">
            <Field
              id="net-extips"
              label={t("External IPs")}
              hint={t("Informe um endereço por linha. Deixe vazio para desativar.")}
              value={externalIPs}
              onChange={setExternalIPs}
              placeholder={suggestedIPs.length ? suggestedIPs.join("\n") : "192.168.0.42"}
              multiline
            />
          </div>
          {suggestedIPs.length ? (
            <div className="network-suggestions">
              <span>{t("Detected in this cluster")}</span>
              <div>
                {suggestedIPs.map((ip) => (
                  <button
                    key={ip}
                    type="button"
                    className="ip-suggestion"
                    onClick={() => setExternalIPs((curr) => (curr.includes(ip) ? curr : (curr ? curr + "\n" : "") + ip))}
                  >
                    <span aria-hidden="true">+</span>{ip}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="network-note"><Info size={15} /><span>{t("O kube-proxy encaminha a Service port para todas as réplicas que correspondem ao selector do serviço.")}</span></div>
        </div>
      </section>

      {info ? <div className="network-result" role="status"><CheckCircle2 size={17} /><span><strong>{t("Networking updated")}</strong>{info}</span></div> : null}

      <div className="dialog-actions justify-between">
        <AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton>
        <AppButton onClick={save} disabled={busy}>{busy ? t("Saving…") : t("Apply networking changes")}</AppButton>
      </div>
    </div>
  );
}
