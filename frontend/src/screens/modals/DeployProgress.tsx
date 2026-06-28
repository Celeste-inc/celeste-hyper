import { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, History, XCircle } from "lucide-react";
import type { Deployment } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Pill } from "../../components/atoms/Pill";
import type { ModalActions } from "../types";

export function DeployProgress({ name, tag, deploymentId, closeModal, load, setModal }: ModalActions & { name: string; tag: string; deploymentId: number }) {
  const [deployment, setDeployment] = useState<Deployment>({ id: deploymentId, service: name, tag, status: "pending" });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let active = true;
    const tick = async () => {
      const result = await http.deployment(deploymentId);
      if (!active || result.status >= 400 || !result.body.deployment) return;
      setDeployment(result.body.deployment);
      if (["done", "failed"].includes(result.body.deployment.status)) await load();
    };
    void tick();
    const pollTimer = window.setInterval(() => void tick(), 1500);
    const elapsedTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      window.clearInterval(pollTimer);
      window.clearInterval(elapsedTimer);
    };
  }, [deploymentId, load]);

  const final = deployment.status === "done" || deployment.status === "failed";
  const elapsed = useMemo(() => {
    const startedAt = deployment.started_at ? new Date(deployment.started_at).getTime() : now;
    const finishedAt = deployment.finished_at ? new Date(deployment.finished_at).getTime() : now;
    return Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  }, [deployment.finished_at, deployment.started_at, now]);
  const StatusIcon = deployment.status === "done" ? CheckCircle2 : deployment.status === "failed" ? XCircle : Activity;

  return (
    <>
      <h2 className="dialog-title">{name}:{tag}</h2>
      <div className="deploy-status">
        <span className={final ? "" : "pulse"} />
        <StatusIcon size={28} />
        <div><Pill className="status-pill" tone={deployment.status}>{deployment.status}</Pill><p>{elapsed}{t("s elapsed")}</p></div>
      </div>
      <p className="text-[var(--mut)]">{deployment.message || (final ? "" : t("Running in the background. This dialog updates automatically."))}</p>
      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{final ? t("Close") : t("Hide (deploy keeps running)")}</AppButton>{final ? <AppButton onClick={() => setModal({ type: "history", name })}><History size={15} />{t("Open history")}</AppButton> : null}</div>
    </>
  );
}
