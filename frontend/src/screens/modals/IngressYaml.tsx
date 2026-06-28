import { useEffect, useState } from "react";
import { FileCode2 } from "lucide-react";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import type { ModalActions } from "../types";

export function IngressYaml({
  clusterId,
  namespace,
  name,
  closeModal,
}: ModalActions & { clusterId: string; namespace: string; name: string }) {
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void http.ingressYaml(clusterId, namespace, name).then((res) => {
      if (res.status >= 400) setError(apiError(res.body, res.status));
      else setYaml(res.body.yaml);
    });
  }, [clusterId, namespace, name]);

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><FileCode2 size={22} />{t("Ingress")} {name}</h2>
      <p className="dialog-description">{t("Namespace")} <code>{namespace}</code> · {t("cluster")} <code>{clusterId}</code> {t("(read-only)")}</p>
      {error ? <p className="notice" role="alert">{error}</p> : null}
      {yaml === null && !error ? <p className="text-[var(--mut)]">{t("Loading...")}</p> : null}
      {yaml !== null ? <pre className="log-viewer wrap" aria-label={t("ingress yaml")}>{yaml}</pre> : null}
      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}
