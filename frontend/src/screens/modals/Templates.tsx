import { useEffect, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import { http } from "../../shared/api/client";
import type { DockerHubImage, Template } from "../../shared/types/api";
import { AppButton } from "../../components/atoms/AppButton";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";

export function Templates({ setModal, closeModal }: ModalActions) {
  const [catalog, setCatalog] = useState<Template[]>([]);
  const [query, setQuery] = useState("");
  const [hubResults, setHubResults] = useState<DockerHubImage[]>([]);
  const [searching, setSearching] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");

  useEffect(() => {
    void http.templates().then((res) => {
      if (res.status === 200) setCatalog(res.body.items);
    });
  }, []);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setHubError(null);
    const res = await http.searchDockerHub(q);
    setSearching(false);
    if (res.status !== 200) {
      setHubError(res.body.error ?? `HTTP ${res.status}`);
      setHubResults([]);
      setSearchedQuery(q);
      return;
    }
    setHubResults(res.body.items);
    setSearchedQuery(q);
  };

  return (
    <div className="template-browser">
      <h2 className="dialog-title">{t("Deploy from template")}</h2>
      <p className="dialog-description">
        {t("Pick a curated public image or search Docker Hub. Hyper provisions the Deployment, a native LB (v1/Service), and an optional HPA.")}
      </p>

      <form className="template-search" role="search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label className="template-search-label" htmlFor="dh-q">{t("Search Docker Hub")}</label>
        <div className="template-search-row">
          <div className="input-with-icon">
            <Search size={16} aria-hidden="true" />
            <input
              id="dh-q"
              className="hyper-input"
              type="search"
              value={query}
              placeholder="nginx, postgres, redis, …"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <AppButton type="submit" disabled={searching || !query.trim()}>
            {searching ? t("Searching…") : t("Search")}
          </AppButton>
        </div>
        <span>{t("Search millions of public images without leaving the deployment flow.")}</span>
      </form>

      {hubError ? <p className="template-feedback bad" role="alert">{hubError}</p> : null}
      {searchedQuery && !hubError ? (
        <section className="template-results" aria-live="polite">
          <div className="template-section-heading">
            <div>
              <h4>{t("Docker Hub results")}</h4>
              <p>{hubResults.length ? `${hubResults.length} ${t("results for")} “${searchedQuery}”` : `${t("No results for")} “${searchedQuery}”`}</p>
            </div>
          </div>
          {hubResults.length > 0 ? (
            <ul className="template-grid" aria-label={t("Docker Hub results")}>
              {hubResults.map((img) => (
                <li className="template-card" key={img.name}>
                  <div className="template-card-heading">
                    <strong>{img.name}</strong>
                    {img.official ? <Pill tone="acc">{t("official")}</Pill> : null}
                  </div>
                  <p>{img.description || "—"}</p>
                  <div className="template-card-meta"><Tag>★ {img.stars}</Tag></div>
                </li>
              ))}
            </ul>
          ) : <div className="template-empty">{t("Try a broader image name or check the spelling.")}</div>}
        </section>
      ) : null}

      <div className="template-section-heading">
        <div>
          <h4>{t("Curated catalog")}</h4>
          <p>{t("Production-ready starting points with sensible defaults.")}</p>
        </div>
        <Pill tone="acc">{catalog.length} {t("templates")}</Pill>
      </div>
      <ul className="template-grid" aria-label={t("Template catalog")}>
        {catalog.map((tpl) => (
          <li className="template-card curated" key={tpl.id}>
            <div className="template-card-heading">
              <strong>{tpl.label}</strong>
              <Pill tone="acc">{tpl.category}</Pill>
            </div>
            <div className="template-card-meta">
              <Tag>{tpl.image}:{tpl.defaultTag}</Tag>
              <Tag>:{tpl.defaultPort}</Tag>
            </div>
            <p>{tpl.description}</p>
            <AppButton className="template-deploy-button" onClick={() => setModal({ type: "template-deploy", templateId: tpl.id })}>
              {t("Deploy")}<ArrowRight size={14} />
            </AppButton>
          </li>
        ))}
      </ul>

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </div>
  );
}
