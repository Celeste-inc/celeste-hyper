import { useEffect, useState } from "react";
import { http } from "../../shared/api/client";
import type { ScalingCapability } from "../../shared/types/api";
import { AppButton } from "../../components/atoms/AppButton";
import { Field } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";
import { apiError } from "../../shared/utils/format";

export function Scaling({ name, notify, closeModal, load }: ModalActions & { name: string }) {
  const [capability, setCapability] = useState<ScalingCapability | null>(null);
  const [cpuReq, setCpuReq] = useState("");
  const [memReq, setMemReq] = useState("");
  const [cpuLim, setCpuLim] = useState("");
  const [memLim, setMemLim] = useState("");
  const [storageReq, setStorageReq] = useState("");
  const [pvcInputs, setPvcInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void http.scalingCapability(name).then((res) => {
      if (res.status !== 200) {
        notify(apiError(res.body, res.status), "bad");
        return;
      }
      setCapability(res.body);
      setCpuReq(res.body.resources.requests.cpu ?? "");
      setMemReq(res.body.resources.requests.memory ?? "");
      setCpuLim(res.body.resources.limits.cpu ?? "");
      setMemLim(res.body.resources.limits.memory ?? "");
      setStorageReq(res.body.resources.requests["ephemeral-storage"] ?? "");
      const next: Record<string, string> = {};
      for (const p of res.body.pvcs) next[p.name] = p.requested;
      setPvcInputs(next);
    });
  }, [name, notify]);

  const saveResources = async () => {
    setBusy(true);
    const body = {
      requests: {
        cpu: cpuReq.trim() || undefined,
        memory: memReq.trim() || undefined,
        "ephemeral-storage": storageReq.trim() || undefined,
      },
      limits: {
        cpu: cpuLim.trim() || undefined,
        memory: memLim.trim() || undefined,
      },
    };
    const res = await http.patchResources(name, body);
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    notify(t("Resources updated — workload is rolling"));
    await load();
  };

  const expand = async (pvc: string, to: string) => {
    setBusy(true);
    const res = await http.expandPvc(name, pvc, to);
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    notify(`${t("PVC")} ${pvc}: ${res.body.from} → ${res.body.to}`);
    await load();
  };

  if (!capability) {
    return (
      <>
        <h2 className="dialog-title">{t("Scaling")}: <code>{name}</code></h2>
        <p className="dialog-description">{t("Reading the workload…")}</p>
        <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
      </>
    );
  }

  return (
    <>
      <h2 className="dialog-title">{t("Scaling")}: <code>{name}</code></h2>
      <p className="dialog-description">
        <Pill tone={capability.horizontal ? "acc" : "warn"}>{capability.horizontal ? t("Horizontal scaling: ENABLED") : t("Horizontal scaling: DISABLED")}</Pill>
        {" "}
        <Pill tone="acc">{t("Vertical scaling: ENABLED")}</Pill>
      </p>

      <h4 className="detail-subtitle">{t("Why this verdict")}</h4>
      <ul className="detail-list" aria-label={t("Scaling capability reasons")}>
        {capability.reasons.map((reason) => (
          <li key={reason}><span style={{ fontSize: 13 }}>{reason}</span></li>
        ))}
      </ul>

      <h4 className="detail-subtitle">{t("Vertical: CPU / Memory / Storage requests + limits")}</h4>
      <p className="text-[var(--mut)]" style={{ fontSize: 12, marginTop: -4 }}>
        {t("Aplica via kubectl patch strategic — rolling pod-by-pod, sem perda de dados. Bump conservador: requests aumentam o reservado; limits o teto.")}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field id="vs-cpu-req" label={t("CPU request")} value={cpuReq} onChange={setCpuReq} placeholder="500m" />
        <Field id="vs-cpu-lim" label={t("CPU limit")} value={cpuLim} onChange={setCpuLim} placeholder="1" />
        <Field id="vs-mem-req" label={t("Memory request")} value={memReq} onChange={setMemReq} placeholder="512Mi" />
        <Field id="vs-mem-lim" label={t("Memory limit")} value={memLim} onChange={setMemLim} placeholder="1Gi" />
        <Field id="vs-storage-req" label={t("Ephemeral storage request (opcional)")} value={storageReq} onChange={setStorageReq} placeholder="5Gi" />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <AppButton onClick={saveResources} disabled={busy}>{busy ? t("Saving…") : t("Apply vertical scaling")}</AppButton>
      </div>

      {capability.pvcs.length > 0 ? (
        <>
          <h4 className="detail-subtitle">{t("Persistent volumes (online expand)")}</h4>
          <p className="text-[var(--mut)]" style={{ fontSize: 12, marginTop: -4 }}>
            {t("Cada PVC só pode crescer (k8s não encolhe online) e só quando o StorageClass marca allowVolumeExpansion: true.")}
          </p>
          <ul className="detail-list" aria-label={t("PVC expand controls")}>
            {capability.pvcs.map((pvc) => (
              <li key={pvc.name} style={{ alignItems: "stretch", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{pvc.name}</strong>
                  {pvc.storageClass ? <Tag>SC: {pvc.storageClass}</Tag> : <Tag>SC: —</Tag>}
                  <Tag>{pvc.accessModes.join(", ") || "—"}</Tag>
                  <Pill tone={pvc.expandable === true ? "acc" : pvc.expandable === false ? "warn" : "warn"}>
                    {pvc.expandable === true ? t("expandable") : pvc.expandable === false ? t("not expandable") : t("expandable: unknown")}
                  </Pill>
                  <span className="text-[var(--mut)]" style={{ fontSize: 12 }}>{t("current")}: {pvc.requested}</span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <Field
                      id={`pvc-${pvc.name}`}
                      label={t("New size (must be larger)")}
                      value={pvcInputs[pvc.name] ?? ""}
                      onChange={(v) => setPvcInputs((curr) => ({ ...curr, [pvc.name]: v }))}
                      placeholder={pvc.requested}
                    />
                  </div>
                  <AppButton
                    disabled={busy || pvc.expandable === false || !(pvcInputs[pvc.name] ?? "").trim() || (pvcInputs[pvc.name] ?? "") === pvc.requested}
                    onClick={() => void expand(pvc.name, pvcInputs[pvc.name]!.trim())}
                  >
                    {t("Expand")}
                  </AppButton>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}
