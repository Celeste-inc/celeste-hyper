import { useState } from "react";
import { Gauge } from "lucide-react";
import type { HpaView } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field } from "../../components/atoms/Field";
import type { ModalActions } from "../types";

export function HpaEdit({ name, hpa, notify, closeModal, load }: ModalActions & { name: string; hpa: HpaView }) {
  const [min, setMin] = useState(String(hpa.minReplicas ?? ""));
  const [max, setMax] = useState(String(hpa.maxReplicas ?? ""));
  const [cpu, setCpu] = useState(String(hpa.targetCPUUtilizationPercentage ?? ""));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body: { min?: number; max?: number; targetCPUUtilizationPercentage?: number } = {};
    const num = (s: string): number | undefined => (s.trim() && !Number.isNaN(Number(s)) ? Number(s) : undefined);
    if (num(min) !== undefined) body.min = num(min);
    if (num(max) !== undefined) body.max = num(max);
    if (num(cpu) !== undefined) body.targetCPUUtilizationPercentage = num(cpu);
    setBusy(true);
    const res = await http.patchHpa(name, body);
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    notify(`Autoscaling updated for ${name}`);
    await load();
    closeModal();
  };

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Gauge size={22} />{t("Autoscaling")} · {name}</h2>
      <p className="dialog-description">{t("Bounds: 1 ≤ min ≤ max ≤ 1000; CPU target 1–100%. Other HPA metrics are preserved.")}</p>
      <Field id="hpa-min" label={t("Min replicas")} value={min} onChange={setMin} />
      <Field id="hpa-max" label={t("Max replicas")} value={max} onChange={setMax} />
      <Field id="hpa-cpu" label={t("Target CPU %")} value={cpu} onChange={setCpu} />
      <div className="dialog-actions">
        <AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton>
        <AppButton onClick={() => void save()} disabled={busy}><Gauge size={15} />{busy ? t("Saving...") : t("Save")}</AppButton>
      </div>
    </>
  );
}
