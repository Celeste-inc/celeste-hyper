import { useState } from "react";
import { Radar } from "lucide-react";
import type { DiscoveryCandidate, DiscoveryScanResult } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";

export function Discovery({ notify, closeModal, setModal }: ModalActions) {
  const [targets, setTargets] = useState("");
  const [ports, setPorts] = useState("");
  const [consent, setConsent] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<DiscoveryScanResult | null>(null);

  const scan = async () => {
    const targetList = targets.split(/[\n,]/).map((target) => target.trim()).filter(Boolean);
    if (targetList.length === 0) {
      notify(t("Add at least one IP or CIDR to scan"), "bad");
      return;
    }
    const portList = ports
      .split(",")
      .map((port) => Number(port.trim()))
      .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
    setScanning(true);
    setResult(null); // never show a prior scan's hosts next to a new error
    try {
      const res = await http.scanDiscovery({
        targets: targetList,
        ...(portList.length ? { ports: portList } : {}),
        consent: consent ? "scan-acknowledged" : "",
      });
      if (res.status >= 400) {
        const message = (res.body as { message?: string }).message;
        notify(message ?? apiError(res.body, res.status), "bad");
        return;
      }
      setResult(res.body);
    } catch (e) {
      notify(e instanceof Error ? e.message : t("Scan request failed"), "bad");
    } finally {
      setScanning(false); // always re-enable the button, even on a network error
    }
  };

  const promote = (candidate: DiscoveryCandidate) => {
    setModal({
      type: "cluster-create",
      prefill: {
        name: `discovered-${candidate.ip}`,
        notes: `API server https://${candidate.ip}:${candidate.port} (${candidate.distribution} ${candidate.serverVersion ?? ""})`,
      },
    });
  };

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Radar size={22} />{t("Discovery")}</h2>
      <p className="dialog-description">{t("Scan IPs and CIDRs for reachable Kubernetes API servers.")}</p>

      <section className="integration-section">
        <Field id="dc-targets" label={t("Targets")} value={targets} placeholder={t("10.0.0.0/24")} hint={t("One IP or CIDR per line (or comma-separated). Up to 1024 addresses per scan.")} multiline onChange={setTargets} />
        <Field id="dc-ports" label={t("Ports")} value={ports} placeholder={t("optional — defaults 6443, 8443, 16443")} onChange={setPorts} />
        <label className="settings-check" htmlFor="dc-consent">
          <input id="dc-consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          <span>{t("I am authorized to scan these hosts")}<br /><span className="text-[11px] text-[var(--mut)]">{t("Network scanning without authorization may violate policy or law. Only scan ranges you own or operate.")}</span></span>
        </label>
        <AppButton disabled={!consent || scanning} onClick={scan}>{scanning ? t("Scanning…") : t("Scan")}</AppButton>
      </section>

      {result ? (
        <section className="integration-section">
          <h3 className="integration-heading">{t("Results · ")}{result.candidates.length}{t(" found · ")}{result.ipsScanned}{t(" IPs · ")}{result.tuplesScanned}{t(" probes")}{result.timedOut ? t(" · timed out — results may be incomplete") : ""}</h3>
          {result.candidates.length === 0 ? <p className="text-[var(--mut)]">{t("No Kubernetes API servers found.")}</p> : (
            <div className="table-wrap"><table><thead><tr><th>{t("IP")}</th><th>{t("Port")}</th><th>{t("Distribution")}</th><th>{t("Version")}</th><th>{t("Latency")}</th><th /></tr></thead><tbody>{result.candidates.map((candidate) => (
              <tr key={`${candidate.ip}:${candidate.port}`}>
                <td><Tag>{candidate.ip}</Tag></td>
                <td>{candidate.port}</td>
                <td><Pill tone="acc">{candidate.distribution}</Pill></td>
                <td>{candidate.serverVersion ? <Tag>{candidate.serverVersion}</Tag> : "—"}</td>
                <td>{candidate.ms} ms</td>
                <td><AppButton onClick={() => promote(candidate)}>{t("Promote to cluster")}</AppButton></td>
              </tr>
            ))}</tbody></table></div>
          )}
        </section>
      ) : null}

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}
