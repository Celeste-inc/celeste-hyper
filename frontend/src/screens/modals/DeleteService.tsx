import { useEffect, useState } from "react";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { AppButton } from "../../components/atoms/AppButton";
import { Field } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";
import type { PurgeResult } from "../../shared/types/api";
import { t } from "../../shared/i18n/t";

export function DeleteService({ name, notify, closeModal, load }: ModalActions & { name: string }) {
  const [typed, setTyped] = useState("");
  const [plan, setPlan] = useState<PurgeResult | null>(null);
  const [previewing, setPreviewing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PurgeResult | null>(null);

  useEffect(() => {
    let alive = true;
    void http.deleteService(name, { dryRun: true }).then((res) => {
      if (!alive) return;
      if (res.status === 200) setPlan(res.body.purge);
      setPreviewing(false);
    });
    return () => {
      alive = false;
    };
  }, [name]);

  const confirmed = typed.trim() === name;

  const confirm = async () => {
    if (!confirmed) return;
    setBusy(true);
    const res = await http.deleteService(name);
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    setDone(res.body.purge);
    notify(t("Service purged"));
    await load();
  };

  if (done) {
    return (
      <>
        <h2 className="dialog-title">{t("Service purged")}: <code>{name}</code></h2>
        <p className="dialog-description">
          <Pill tone="acc">{done.removed.length} {t("resources removed")}</Pill>
          {done.failed.length > 0 ? <> <Pill tone="warn">{done.failed.length} {t("failed")}</Pill></> : null}
        </p>
        <PurgeManifest plan={done} />
        <div className="dialog-actions"><AppButton onClick={closeModal}>{t("Close")}</AppButton></div>
      </>
    );
  }

  return (
    <>
      <h2 className="dialog-title">{t("Delete service")}: <code>{name}</code></h2>
      <p className="dialog-description">
        {t("This will undeploy the workload AND remove every Celeste-managed resource backing this service in its cluster.")}
        <br />
        <strong>{t("Other services are NOT affected.")}</strong>
      </p>
      {previewing ? (
        <p className="dialog-description">{t("Computing purge plan…")}</p>
      ) : plan ? (
        <>
          <h4 className="detail-subtitle">{t("Will be removed")}</h4>
          <PurgeManifest plan={plan} />
        </>
      ) : null}
      <Field
        id="confirm-delete"
        label={t("Type the service name to confirm:")}
        value={typed}
        onChange={setTyped}
        placeholder={name}
      />
      <div className="dialog-actions justify-between">
        <AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton>
        <AppButton variant="danger" disabled={!confirmed || busy} onClick={confirm}>
          {busy ? t("Purging…") : t("Delete and purge")}
        </AppButton>
      </div>
    </>
  );
}

function PurgeManifest({ plan }: { plan: PurgeResult }) {
  const items = plan.planned.length ? plan.planned : plan.removed;
  if (!items.length) {
    return <p className="text-[var(--mut)]">{t("Nothing to remove.")}</p>;
  }
  return (
    <ul className="detail-list" aria-label={t("Purge manifest")}>
      {items.map((r) => (
        <li key={r}>
          <Tag>{r}</Tag>
          {plan.failed.find((f) => f.resource === r) ? <Pill tone="warn">{t("failed")}</Pill> : null}
        </li>
      ))}
    </ul>
  );
}
