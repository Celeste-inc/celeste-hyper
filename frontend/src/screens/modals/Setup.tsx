import { useEffect, useState } from "react";
import { Rocket, Settings2 } from "lucide-react";
import type { Cluster, R2Source, SetupServiceTemplate, SetupStatus } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";

export function Setup({ notify, closeModal, load }: ModalActions) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [selectedR2SourceId, setSelectedR2SourceId] = useState("default");
  const [sourceId, setSourceId] = useState("default");
  const [sourceName, setSourceName] = useState("Default R2");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("auto");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [prefixes, setPrefixes] = useState<string[] | null>(null);
  const [clusterId, setClusterId] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [selected, setSelected] = useState<string[]>([]);
  const [overwriteEnvTemplates, setOverwriteEnvTemplates] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const result = await http.setupStatus();
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    const next = result.body;
    setStatus(next);
    const selected = next.r2Sources.find((source) => source.id === selectedR2SourceId) || next.r2Sources[0];
    if (selected) applySource(selected);
    const firstCluster = next.clusters[0];
    setClusterId((current) => current || firstCluster?.id || "");
    setNamespace((current) => current === "default" ? firstCluster?.defaultNamespace || "default" : current);
    setSelected((current) => current.length ? current : next.services.map((service) => service.name));
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!status) return <><h2 className="dialog-title">{t("Setup")}</h2><p className="text-[var(--mut)]">{t("Loading...")}</p></>;

  const applySource = (source: R2Source) => {
    setSelectedR2SourceId(source.id);
    setSourceId(source.id);
    setSourceName(source.name);
    setEndpoint(source.endpoint || "");
    setBucket(source.bucket || "");
    setRegion(source.region || "auto");
    setAccessKeyId(source.accessKeyId || "");
    setSecretAccessKey("");
    setPrefixes(null);
  };

  const r2Payload = () => ({ id: sourceId.trim(), name: sourceName.trim(), endpoint: endpoint.trim(), bucket: bucket.trim(), region: region.trim() || "auto", accessKeyId: accessKeyId.trim(), ...(secretAccessKey.trim() ? { secretAccessKey } : {}) });

  const selectSource = (id: string) => {
    const source = status.r2Sources.find((item) => item.id === id);
    if (source) applySource(source);
  };

  const newSource = () => {
    setSelectedR2SourceId("");
    setSourceId("");
    setSourceName("");
    setEndpoint("");
    setBucket("");
    setRegion("auto");
    setAccessKeyId("");
    setSecretAccessKey("");
    setPrefixes(null);
  };

  const testR2 = async () => {
    setBusy(true);
    try {
      const result = await http.testR2Settings(r2Payload());
      if (result.status >= 400) {
        notify(apiError(result.body, result.status), "bad");
        return;
      }
      setPrefixes(result.body.prefixes || []);
      notify(t("R2 connection ok"));
    } finally {
      setBusy(false);
    }
  };

  const saveR2 = async () => {
    setBusy(true);
    try {
      const result = await http.saveR2Source(r2Payload());
      if (result.status >= 400) {
        notify(apiError(result.body, result.status), "bad");
        return;
      }
      setSecretAccessKey("");
      setSelectedR2SourceId(result.body.id);
      notify(t("R2 source saved"));
      await refresh();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const bootstrap = async () => {
    if (!clusterId) {
      notify(t("Select a cluster first"), "bad");
      return;
    }
    const services = status.services.filter((service) => selected.includes(service.name)).map(({ name, r2Prefix, configEnv, secretEnv }) => ({ name, r2Prefix, configEnv, secretEnv }));
    if (services.length === 0) {
      notify(t("Select at least one service"), "bad");
      return;
    }
    setBusy(true);
    try {
      const result = await http.bootstrapSetup({ clusterId, namespace: namespace || "default", services, r2SourceId: selectedR2SourceId || "default", writeEnvTemplates: true, overwriteEnvTemplates });
      if (result.status >= 400) {
        notify(apiError(result.body, result.status), "bad");
        return;
      }
      notify(t("Services configured"));
      await refresh();
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Settings2 size={22} />{t("Setup")}</h2>
      <p className="dialog-description">{t("Configure this host to deploy services from Cloudflare R2 and create their environment files.")}</p>

      <section className="integration-section">
        <h3 className="integration-heading">{t("Cloudflare R2 sources")}</h3>
        <div className="integration-form">
          <SelectField id="setup-r2-source" label={t("Saved source")} value={selectedR2SourceId || ""} options={r2SourceOptions(status.r2Sources)} onChange={selectSource} />
          <div className="mb-4"><AppButton variant="ghost" onClick={newSource}>{t("Add R2 source")}</AppButton></div>
          <Field id="setup-r2-id" label={t("Source ID")} value={sourceId} placeholder="production" readOnly={selectedR2SourceId === "default"} onChange={setSourceId} />
          <Field id="setup-r2-name" label={t("Source name")} value={sourceName} placeholder="Production" onChange={setSourceName} />
          <Field id="setup-r2-endpoint" label={t("Endpoint URL")} value={endpoint} placeholder="https://<account>.r2.cloudflarestorage.com" onChange={setEndpoint} />
          <Field id="setup-r2-bucket" label={t("Bucket")} value={bucket} placeholder="service-builds" onChange={setBucket} />
          <Field id="setup-r2-region" label={t("Region")} value={region} placeholder="auto" onChange={setRegion} />
          <Field id="setup-r2-key" label={t("Access key ID")} value={accessKeyId} onChange={setAccessKeyId} />
          <Field id="setup-r2-secret" label={t("Secret access key")} value={secretAccessKey} placeholder={status.r2Sources.find((source) => source.id === selectedR2SourceId)?.secretConfigured ? t("leave blank to keep current secret") : ""} onChange={setSecretAccessKey} />
          <div className="flex flex-wrap gap-2"><AppButton disabled={busy} onClick={testR2}>{t("Test connection")}</AppButton><AppButton variant="ghost" disabled={busy} onClick={saveR2}>{t("Save source")}</AppButton></div>
        </div>
        {prefixes ? <p className="text-[var(--mut)]">{prefixes.length ? `${t("Top-level prefixes")}: ${prefixes.join(", ")}` : t("Connection succeeded, but no prefixes were found.")}</p> : null}
      </section>

      <section className="integration-section">
        <h3 className="integration-heading">{t("Services")}</h3>
        <div className="integration-form">
          <SelectField id="setup-cluster" label={t("Cluster")} value={clusterId} options={clusterOptions(status.clusters)} onChange={(id) => selectCluster(status.clusters, id, setClusterId, setNamespace)} />
          <Field id="setup-namespace" label={t("Namespace")} value={namespace} onChange={setNamespace} />
        </div>
        {status.services.length ? <div className="setup-service-list">
          {status.services.map((preset) => <PresetRow key={preset.name} preset={preset} selected={selected.includes(preset.name)} onToggle={() => setSelected((items) => items.includes(preset.name) ? items.filter((item) => item !== preset.name) : [...items, preset.name])} />)}
        </div> : <p className="text-[var(--mut)]">{t("No setup services are defined in the server config. Add services manually from the dashboard or seed config.services first.")}</p>}
        <label className="settings-check" htmlFor="setup-overwrite-env">
          <input id="setup-overwrite-env" type="checkbox" checked={overwriteEnvTemplates} onChange={(event) => setOverwriteEnvTemplates(event.target.checked)} />
          <span>{t("Overwrite existing env templates")}<br /><span className="text-[11px] text-[var(--mut)]">{t("Keep this off on production hosts that already have real secrets.")}</span></span>
        </label>
        <div className="flex flex-wrap gap-2"><AppButton disabled={busy || selected.length === 0} onClick={bootstrap}><Rocket size={15} />{t("Configure selected services")}</AppButton></div>
      </section>

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}

function clusterOptions(clusters: Cluster[]) {
  if (clusters.length === 0) return [{ value: "", label: t("No clusters configured") }];
  return clusters.map((cluster) => ({ value: cluster.id, label: `${cluster.name} (${cluster.id})` }));
}

function selectCluster(clusters: Cluster[], id: string, setClusterId: (id: string) => void, setNamespace: (namespace: string) => void) {
  setClusterId(id);
  const cluster = clusters.find((item) => item.id === id);
  if (cluster) setNamespace(cluster.defaultNamespace || "default");
}

function r2SourceOptions(sources: R2Source[]) {
  const options = sources.map((source) => ({ value: source.id, label: `${source.name} (${source.bucket})` }));
  return options.length ? options : [{ value: "default", label: "default" }];
}

function PresetRow({ preset, selected, onToggle }: { preset: SetupServiceTemplate; selected: boolean; onToggle: () => void }) {
  return (
    <label className="setup-service-row">
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <span className="min-w-0 flex-1">
        <strong>{preset.label}</strong>
        <span><Tag>{preset.r2Prefix}</Tag>{preset.registered ? <Pill tone="ok">{t("Registered")}</Pill> : <Pill tone="warn">{t("Missing")}</Pill>}{preset.currentTag ? <Pill tone="acc">{preset.currentTag}</Pill> : null}</span>
      </span>
    </label>
  );
}
