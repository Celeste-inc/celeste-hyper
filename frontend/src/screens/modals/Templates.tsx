import { useEffect, useState } from "react";
import { http } from "../../shared/api/client";
import type { DockerHubImage, Template } from "../../shared/types/api";
import { AppButton } from "../../components/atoms/AppButton";
import { Field } from "../../components/atoms/Field";
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
      return;
    }
    setHubResults(res.body.items);
  };

  return (
    <>
      <h2 className="dialog-title">{t("Deploy from template")}</h2>
      <p className="dialog-description">
        {t("Pick a curated public image or search Docker Hub. Hyper provisions the Deployment, a native LB (v1/Service), and an optional HPA.")}
      </p>

      <h4 className="detail-subtitle">{t("Curated catalog")}</h4>
      <ul className="detail-list" aria-label={t("Template catalog")}>
        {catalog.map((tpl) => (
          <li key={tpl.id} style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong>{tpl.label}</strong>
              <Pill tone="acc">{tpl.category}</Pill>
              <Tag>{tpl.image}:{tpl.defaultTag}</Tag>
              <Tag>:{tpl.defaultPort}</Tag>
            </div>
            <span className="text-[var(--mut)]" style={{ fontSize: 12 }}>{tpl.description}</span>
            <AppButton onClick={() => setModal({ type: "template-deploy", templateId: tpl.id })}>
              {t("Deploy")}
            </AppButton>
          </li>
        ))}
      </ul>

      <h4 className="detail-subtitle">{t("Search Docker Hub")}</h4>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <Field id="dh-q" label={t("Image name")} value={query} onChange={setQuery} placeholder="nginx, postgres, redis, …" />
        </div>
        <AppButton onClick={search} disabled={searching || !query.trim()}>
          {searching ? t("Searching…") : t("Search")}
        </AppButton>
      </div>
      {hubError ? <p className="text-[var(--mut)]" role="alert">{hubError}</p> : null}
      {hubResults.length > 0 ? (
        <ul className="detail-list" aria-label={t("Docker Hub results")}>
          {hubResults.map((img) => (
            <li key={img.name} style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong>{img.name}</strong>
                {img.official ? <Pill tone="acc">{t("official")}</Pill> : null}
                <Tag>★ {img.stars}</Tag>
              </div>
              <span className="text-[var(--mut)]" style={{ fontSize: 12 }}>{img.description || "—"}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}
