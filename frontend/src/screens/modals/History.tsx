import { useEffect, useState } from "react";
import { History as HistoryIcon } from "lucide-react";
import type { Deployment } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { fmtTs } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";

export function History({ name }: { name: string }) {
  const [items, setItems] = useState<Deployment[] | null>(null);

  useEffect(() => {
    void http.deployments(name).then((result) => setItems(result.body.items || []));
  }, [name]);

  if (!items) return <><h2 className="dialog-title">{name} {t("deployment history")}</h2><p className="text-[var(--mut)]">{t("Loading...")}</p></>;

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><HistoryIcon size={22} />{name} {t("deployment history")}</h2>
      <p className="dialog-description">{t("Recent deployment attempts and their results.")}</p>
      {items.length === 0 ? <EmptyInline title={t("No deployment history")}>{t("This service has not been deployed yet.")}</EmptyInline> : (
        <div className="table-wrap"><table><thead><tr><th>{t("Tag")}</th><th>{t("Status")}</th><th>{t("Started")}</th><th>{t("Finished")}</th><th>{t("Message")}</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><Tag>{item.tag}</Tag></td><td><Pill tone={item.status}>{item.status}</Pill></td><td>{fmtTs(item.started_at)}</td><td>{fmtTs(item.finished_at)}</td><td>{item.message || ""}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}

export function EmptyInline({ title, children }: { title: string; children: string }) {
  return <div className="grid min-h-40 place-items-center rounded-[var(--radius-lg)] border border-dashed border-[var(--bord)] p-8 text-center text-[var(--mut)]"><div><strong className="mb-1 block text-sm text-[var(--fg)]">{title}</strong>{children}</div></div>;
}
