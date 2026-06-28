import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import type { RollbackPreview } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { AppButton } from "../../components/atoms/AppButton";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";

export function Rollback({ name, notify, setModal, closeModal }: ModalActions & { name: string }) {
  const [preview, setPreview] = useState<RollbackPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void http.rollbackPreview(name).then((res) => setPreview(res.body));
  }, [name]);

  const confirm = async () => {
    setBusy(true);
    const res = await http.rollback(name);
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    notify(`Rollback of ${name} started (job ${res.body.jobId})`);
    setModal({ type: "history", name });
  };

  if (!preview) return <><h2 className="dialog-title flex items-center gap-2"><Undo2 size={22} />{t("Roll back")} {name}</h2><p className="text-[var(--mut)]">{t("Resolving previous version...")}</p></>;

  if (!preview.eligible) {
    return (
      <>
        <h2 className="dialog-title flex items-center gap-2"><Undo2 size={22} />{t("Roll back")} {name}</h2>
        <p className="notice"><Pill tone="warn">{t("Not available")}</Pill>{preview.reason === "r2-bundle-uses-deploy-history" ? t("R2-bundle services roll back by redeploying a previous tag from History.") : t("No previous version to roll back to.")}</p>
        <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
      </>
    );
  }

  const targetLabel = preview.previousTag ? <Tag>{preview.previousTag}</Tag> : <Tag>{t("revision")} {preview.previousRevision}</Tag>;
  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Undo2 size={22} />{t("Roll back")} {name}</h2>
      <p className="dialog-description">{t("Roll back to")} {targetLabel} <Pill tone="acc">{t("source:")} {preview.source}</Pill></p>
      {preview.source === "cluster" ? <p className="notice"><Pill tone="warn">{t("Heads up")}</Pill>{t("Tag is read from the cluster after the rollback finishes.")}</p> : null}
      <div className="dialog-actions">
        <AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton>
        <AppButton onClick={() => void confirm()} disabled={busy}><Undo2 size={15} />{busy ? t("Rolling back...") : t("Roll back")}</AppButton>
      </div>
    </>
  );
}
