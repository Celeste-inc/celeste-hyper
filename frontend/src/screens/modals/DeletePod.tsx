import { Trash2 } from "lucide-react";
import { useState } from "react";
import { AppButton } from "../../components/atoms/AppButton";
import { http } from "../../shared/api/client";
import { t } from "../../shared/i18n/t";
import { apiError } from "../../shared/utils/format";
import type { ModalActions } from "../types";

export function DeletePod({ name, pod, notify, closeModal }: ModalActions & { name: string; pod: string }) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    const res = await http.deletePod(name, pod);
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    notify(t("Pod scheduled for deletion"));
    closeModal();
  };

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Trash2 size={22} />{t("Delete pod")}</h2>
      <p className="dialog-description">
        {t("Delete pod")} <code>{pod}</code> {t("from service")} <code>{name}</code>?
        <br />
        {t("The Deployment controller will create a replacement.")}
      </p>
      <div className="dialog-actions justify-between">
        <AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton>
        <AppButton variant="danger" disabled={busy} onClick={() => void confirm()}>
          <Trash2 size={15} />{busy ? t("Deleting...") : t("Delete pod")}
        </AppButton>
      </div>
    </>
  );
}
