import { useEffect, useMemo, useState } from "react";
import { Rocket, Search } from "lucide-react";
import type { PreflightResult, Service, VersionItem } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError, fmtSize, fmtTs } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";
import { EmptyInline } from "./History";

export function Deploy({ name, notify, setModal, closeModal }: ModalActions & { name: string }) {
  const [service, setService] = useState<Service | null>(null);
  const [items, setItems] = useState<VersionItem[]>([]);
  const [total, setTotal] = useState<number | undefined>();
  const [hint, setHint] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [manualTag, setManualTag] = useState("");
  const [query, setQuery] = useState("");
  const [preflight, setPreflight] = useState<PreflightResult | "checking" | null>(null);

  // Advisory admission preflight (P3.3): server-side dry-run of the manual tag, debounced.
  useEffect(() => {
    const tag = manualTag.trim();
    if (!tag || service?.sourceType !== "registry-pull") {
      setPreflight(null);
      return;
    }
    let alive = true;
    setPreflight("checking");
    const timer = setTimeout(() => {
      void http.preflight(name, tag).then((res) => {
        if (alive) setPreflight(res.status === 200 ? res.body : null);
      });
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [manualTag, name, service?.sourceType]);

  useEffect(() => {
    void Promise.all([http.service(name), http.versions(name)]).then(([serviceRes, versionRes]) => {
      setService(serviceRes.body.service || null);
      setItems(versionRes.body.items || []);
      setTotal(versionRes.body.total);
      setHint(versionRes.body.hint ?? null);
      setAuthRequired(Boolean(versionRes.body.authRequired));
      setRateLimited(Boolean(versionRes.body.rateLimited));
    });
  }, [name]);

  const filteredTags = useMemo(() => items.map((item) => item.tag).filter((tag) => !query || tag.toLowerCase().includes(query.toLowerCase())).slice(0, 80), [items, query]);

  const deploy = async (tag: string) => {
    if (!tag) {
      notify(t("Enter an image tag"), "bad");
      return;
    }
    const result = await http.deploy(name, tag);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    setModal({ type: "deploy-progress", name, tag, deploymentId: result.body.deploymentId });
  };

  if (!service) return <><h2 className="dialog-title">{t("Deploy")} {name}</h2><p className="text-[var(--mut)]">{t("Loading available versions...")}</p></>;

  const totalNote = total && total > items.length ? ` (showing top ${items.length} of ${total})` : "";

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Rocket size={22} />{t("Deploy")} {name}<Pill tone="acc">{service.deployMode ?? "rolling"}</Pill></h2>
      {service.deployMode === "recreate" ? <p className="notice"><Pill tone="warn">{t("Downtime expected")}</Pill>{t("Recreate stops all pods before starting the new version.")}</p> : null}
      {service.deployMode === "canary" ? <p className="notice"><Pill tone="acc">{t("Canary")}</Pill>{t("A temporary canary is observed for readiness before promotion.")}</p> : null}
      {service.deployMode === "blue-green" ? <p className="notice"><Pill tone="acc">{t("Blue-green")}</Pill>{t("A green deployment is created, the Service is flipped to it, then blue is drained.")}</p> : null}
      {service.sourceType === "r2-bundle" ? <p className="dialog-description">{t("Versions available in the R2 bundle.")}{totalNote}</p> : service.sourceType === "git-sync" ? <p className="dialog-description break-words">{t("Choose a commit for ")}<code>{service.gitUrl}</code>{t(" at ")}<code>{service.gitRef}</code>.</p> : <p className="dialog-description break-words">{t("Choose a tag for ")}<code>{service.imageRef}</code>{t(" in ")}<code>{service.namespace}</code>.</p>}
      {authRequired ? <p className="notice"><Pill tone="warn">{t("Auth required")}</Pill>{t("Enter the tag manually.")}</p> : null}
      {rateLimited ? <p className="notice"><Pill tone="warn">{t("Rate limited")}</Pill>{t("Try again later or enter the tag manually.")}</p> : null}
      {hint && items.length === 0 ? <p className="notice"><Pill tone="warn">{t("Registry hint")}</Pill>{hint}</p> : null}
      {service.sourceType === "r2-bundle" ? <R2Versions items={items} onDeploy={deploy} /> : (
        <>
          {items.length > 0 ? (
            <>
              <label className="mb-2 block text-xs font-semibold" htmlFor="tag-search">{t("Available tags")}{totalNote}</label>
              <div className="input-with-icon mb-4"><Search size={16} /><input id="tag-search" className="hyper-input" value={query} placeholder={t("Filter by tag...")} onChange={(event) => setQuery(event.target.value)} /></div>
              <ul className="tag-list">{filteredTags.length ? filteredTags.map((tag) => <li key={tag}><Tag>{tag}</Tag><AppButton onClick={() => void deploy(tag)}><Rocket size={14} />{t("Deploy")}</AppButton></li>) : <li className="text-[var(--mut)]">{t("No matches.")}</li>}</ul>
            </>
          ) : null}
          <div className="mt-6"><Field id="d-tag" label={t("Or enter a tag manually")} value={manualTag} placeholder={t("v1.2.3 or commit SHA")} hint={t("Useful for private registries or unreleased tags.")} onChange={setManualTag} /></div>
          <Preflight result={preflight} />
          <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton><AppButton onClick={() => void deploy(manualTag.trim())}><Rocket size={15} />{t("Deploy")}</AppButton></div>
        </>
      )}
    </>
  );
}

function Preflight({ result }: { result: PreflightResult | "checking" | null }) {
  if (result === null || (result !== "checking" && !result.applicable)) return null;
  if (result === "checking") return <p className="preflight-note text-[var(--mut)]">{t("Checking admission…")}</p>;
  if (result.ok) return <p className="preflight-note"><Pill tone="ok">{t("admission OK")}</Pill>{t("Passes server-side admission.")}</p>;
  return <p className="preflight-note preflight-deny"><Pill tone="bad">{t("admission denied")}</Pill><span className="break-words">{result.reason || t("rejected by the cluster")}</span></p>;
}

function R2Versions({ items, onDeploy }: { items: VersionItem[]; onDeploy: (tag: string) => Promise<void> }) {
  if (items.length === 0) return <EmptyInline title={t("No versions found")}>{t("There are no available versions under this R2 prefix.")}</EmptyInline>;
  return <div className="table-wrap"><table><thead><tr><th>{t("Tag")}</th><th>{t("Size")}</th><th>{t("Uploaded")}</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.tag}><td><Tag>{item.tag}</Tag></td><td>{fmtSize(item.imageSize)}</td><td>{fmtTs(item.lastModified)}</td><td><AppButton onClick={() => void onDeploy(item.tag)}><Rocket size={14} />{t("Deploy")}</AppButton></td></tr>)}</tbody></table></div>;
}
