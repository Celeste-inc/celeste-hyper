import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Boxes } from "lucide-react";
import type { CrEntry, CrdEntry } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError, fmtTs } from "../../shared/utils/format";
import { AppButton } from "../../components/atoms/AppButton";
import { Field } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { t } from "../../shared/i18n/t";
import type { ModalActions } from "../types";

export function CrdBrowser({ clusterId, notify, closeModal }: ModalActions & { clusterId: string }) {
  const [crds, setCrds] = useState<CrdEntry[] | null>(null);
  const [filter, setFilter] = useState("");
  const [crd, setCrd] = useState<CrdEntry | null>(null);
  const [nsFilter, setNsFilter] = useState("");
  const [objects, setObjects] = useState<CrEntry[] | null>(null);
  const [object, setObject] = useState<CrEntry | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    http.crds(clusterId)
      .then((res) => {
        if (res.status >= 400) {
          notify(apiError(res.body, res.status), "bad");
          setCrds([]);
          return;
        }
        setCrds(res.body.items);
      })
      .catch((e) => {
        notify(e instanceof Error ? e.message : t("Failed to load custom resources"), "bad");
        setCrds([]);
      })
      .finally(() => setLoading(false));
  }, [clusterId, notify]);

  const loadObjects = useCallback(async (target: CrdEntry, ns: string) => {
    setObjects(null);
    setLoading(true);
    try {
      const namespace = target.namespaced ? ns.trim() || undefined : undefined;
      const res = await http.crObjects(clusterId, `${target.plural}.${target.group}`, namespace);
      if (res.status >= 400) {
        notify(apiError(res.body, res.status), "bad");
        setObjects([]);
        return;
      }
      setObjects(res.body.items);
    } catch (e) {
      notify(e instanceof Error ? e.message : t("Failed to load objects"), "bad");
      setObjects([]);
    } finally {
      setLoading(false);
    }
  }, [clusterId, notify]);

  const selectCrd = (target: CrdEntry) => {
    setCrd(target);
    setNsFilter("");
    void loadObjects(target, "");
  };

  const selectObject = useCallback(async (target: CrEntry) => {
    if (!crd) return;
    setLoading(true);
    try {
      const namespace = crd.namespaced ? target.namespace ?? undefined : undefined;
      const res = await http.crYaml(clusterId, `${crd.plural}.${crd.group}`, target.name, namespace);
      if (res.status >= 400) {
        notify(apiError(res.body, res.status), "bad");
        return;
      }
      setObject(target);
      setYaml(res.body.yaml);
    } catch (e) {
      notify(e instanceof Error ? e.message : t("Failed to load YAML"), "bad");
    } finally {
      setLoading(false);
    }
  }, [clusterId, crd, notify]);

  const backToCrds = () => {
    setCrd(null);
    setObjects(null);
    setObject(null);
    setYaml(null);
  };

  const backToObjects = () => {
    setObject(null);
    setYaml(null);
  };

  const filtered = useMemo(() => {
    if (!crds) return [];
    const query = filter.trim().toLowerCase();
    if (!query) return crds;
    return crds.filter((item) => item.name.toLowerCase().includes(query) || item.kind.toLowerCase().includes(query));
  }, [crds, filter]);

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Boxes size={22} />{t("Custom resources")}</h2>
      <p className="dialog-description">{t("Cluster")} <code>{clusterId}</code> {t("(read-only)")}</p>

      {object && crd ? (
        <section className="crd-panel">
          <div className="crd-panel-header">
            <AppButton variant="ghost" onClick={backToObjects}><ArrowLeft size={15} />{t("Back to objects")}</AppButton>
            <div className="crd-panel-title">
              <h3>{crd.kind} · {object.name}</h3>
              <p><code>{crd.plural}.{crd.group}</code>{object.namespace ? <> · {t("Namespace")} <code>{object.namespace}</code></> : null}</p>
            </div>
          </div>
          {yaml === null ? <p className="text-[var(--mut)]">{t("Loading...")}</p> : <pre className="log-viewer wrap" aria-label={t("custom resource yaml")}>{yaml}</pre>}
        </section>
      ) : crd ? (
        <section className="crd-panel">
          <div className="crd-panel-header">
            <AppButton variant="ghost" onClick={backToCrds}><ArrowLeft size={15} />{t("Back to CRDs")}</AppButton>
            <div className="crd-panel-title">
              <h3>{crd.kind} <Pill tone={crd.namespaced ? "acc" : "warn"}>{crd.scope}</Pill></h3>
              <p><code>{crd.plural}.{crd.group}</code> · {crd.version}</p>
            </div>
          </div>
          {crd.namespaced ? (
            <div className="crd-filter-row">
              <Field id="crd-ns" label={t("Namespace")} value={nsFilter} placeholder={t("optional — blank for all namespaces")} onChange={setNsFilter} />
              <AppButton disabled={loading} onClick={() => void loadObjects(crd, nsFilter)}>{t("Apply")}</AppButton>
            </div>
          ) : null}
          {objects === null ? <p className="text-[var(--mut)]">{t("Loading...")}</p> : objects.length === 0 ? <div className="empty-state crd-empty"><Boxes size={18} /><span><strong>{t("No objects.")}</strong><span>{t("This definition has no resources in the current scope.")}</span></span></div> : (
            <div className="table-wrap"><table><thead><tr><th>{t("Name")}</th><th>{t("Namespace")}</th><th>{t("Created")}</th></tr></thead><tbody>{objects.map((item) => (
              <tr key={`${item.namespace ?? ""}/${item.name}`}>
                <td><AppButton variant="ghost" disabled={loading} onClick={() => void selectObject(item)}>{item.name}</AppButton></td>
                <td>{item.namespace ?? "—"}</td>
                <td>{fmtTs(item.createdAt)}</td>
              </tr>
            ))}</tbody></table></div>
          )}
        </section>
      ) : (
        <section className="crd-panel">
          <Field id="crd-filter" label={t("Filter")} value={filter} placeholder={t("filter by kind or name")} onChange={setFilter} />
          {crds === null ? <p className="text-[var(--mut)]">{t("Loading...")}</p> : filtered.length === 0 ? <div className="empty-state crd-empty"><Boxes size={18} /><span><strong>{t("No custom resource definitions.")}</strong><span>{t("Try a different kind or group name.")}</span></span></div> : (
            <div className="crd-list">{filtered.map((item) => (
              <button key={item.name} type="button" className="crd-row" onClick={() => selectCrd(item)}>
                <span className="crd-row-main">
                  <strong>{item.kind}</strong>
                  <Pill tone={item.namespaced ? "acc" : "warn"}>{item.scope}</Pill>
                </span>
                <span className="crd-row-meta"><code>{item.group}</code> · {item.version}</span>
              </button>
            ))}</div>
          )}
        </section>
      )}

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}
