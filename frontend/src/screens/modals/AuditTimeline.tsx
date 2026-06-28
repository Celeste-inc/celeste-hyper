import { useCallback, useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import type { AuditRow } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError, fmtTs } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";

const resultOptions = [
  { value: "any", label: t("any") },
  { value: "ok", label: t("ok") },
  { value: "fail", label: t("fail") },
];

export function AuditTimeline({ notify, closeModal }: ModalActions) {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [resourceKind, setResourceKind] = useState("");
  const [result, setResult] = useState("any");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [appliedQs, setAppliedQs] = useState("");
  const [items, setItems] = useState<AuditRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (baseQs: string, cursor: string | null, append: boolean) => {
    const params = new URLSearchParams(baseQs);
    if (cursor) params.set("cursor", cursor);
    setLoading(true);
    try {
      const res = await http.audit(params.toString());
      if (res.status >= 400) {
        notify(apiError(res.body, res.status), "bad");
        return;
      }
      setItems((prev) => (append && prev ? [...prev, ...res.body.items] : res.body.items));
      setNextCursor(res.body.nextCursor);
    } catch (e) {
      notify(e instanceof Error ? e.message : t("Failed to load audit log"), "bad");
    } finally {
      setLoading(false); // always re-enable controls, even on a network error
    }
  }, [notify]);

  useEffect(() => {
    void run("", null, false);
  }, [run]);

  const applyFilters = () => {
    const qs = buildQuery({ actor, action, resourceKind, result, since, until });
    setAppliedQs(qs);
    void run(qs, null, false); // reset cursor + items, reload from page 1
  };

  const loadMore = () => {
    if (!nextCursor) return;
    void run(appliedQs, nextCursor, true);
  };

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><ScrollText size={22} />{t("Audit")}</h2>
      <p className="dialog-description">{t("Audit trail of API requests and system actions. Newest first.")}</p>

      <section className="integration-section">
        <h3 className="integration-heading">{t("Filters")}</h3>
        <div className="integration-form">
          <Field id="au-actor" label={t("Actor")} value={actor} placeholder={t("optional — username, system or anonymous")} onChange={setActor} />
          <Field id="au-action" label={t("Action (exact)")} value={action} placeholder={t("optional — e.g. job:deploy")} onChange={setAction} />
          <Field id="au-kind" label={t("Resource kind")} value={resourceKind} placeholder={t("optional — e.g. service")} onChange={setResourceKind} />
          <SelectField id="au-result" label={t("Result")} value={result} options={resultOptions} onChange={setResult} />
          <Field id="au-since" label={t("Since")} value={since} placeholder={t("optional — ISO datetime")} onChange={setSince} />
          <Field id="au-until" label={t("Until")} value={until} placeholder={t("optional — ISO datetime")} onChange={setUntil} />
          <AppButton disabled={loading} onClick={applyFilters}>{t("Apply filters")}</AppButton>
        </div>
      </section>

      <section className="integration-section">
        <h3 className="integration-heading">{t("Events")}</h3>
        {items === null ? <p className="text-[var(--mut)]">{t("Loading...")}</p> : items.length === 0 ? <p className="text-[var(--mut)]">{t("No audit events.")}</p> : (
          <div className="table-wrap"><table><thead><tr><th>{t("Time")}</th><th>{t("Actor")}</th><th>{t("Action")}</th><th>{t("Resource")}</th><th>{t("Result")}</th><th>{t("Message")}</th></tr></thead><tbody>{items.map((row) => (
            <tr key={row.id}>
              <td>{fmtTs(row.ts)}</td>
              <td><Tag>{row.actor}</Tag></td>
              <td>{row.action}</td>
              <td>{resourceLabel(row)}</td>
              <td><Pill tone={row.result === "ok" ? "ok" : "bad"}>{row.result}</Pill></td>
              <td>{row.message || "—"}</td>
            </tr>
          ))}</tbody></table></div>
        )}
        {nextCursor ? <div className="integration-form"><AppButton variant="ghost" disabled={loading} onClick={loadMore}>{loading ? t("Loading…") : t("Load more")}</AppButton></div> : null}
      </section>

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}

function buildQuery(filters: { actor: string; action: string; resourceKind: string; result: string; since: string; until: string }): string {
  const params = new URLSearchParams();
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.resourceKind.trim()) params.set("resource_kind", filters.resourceKind.trim());
  if (filters.result !== "any") params.set("result", filters.result);
  if (filters.since.trim()) params.set("since", filters.since.trim());
  if (filters.until.trim()) params.set("until", filters.until.trim());
  return params.toString();
}

function resourceLabel(row: AuditRow): string {
  if (!row.resource_kind) return "—";
  return row.resource_id ? `${row.resource_kind}/${row.resource_id}` : row.resource_kind;
}
