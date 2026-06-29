import { useEffect, useState } from "react";
import { http } from "../../shared/api/client";
import type { RegistryPreset, RegistryPresetId, RegistrySourceSummary } from "../../shared/types/api";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";
import { apiError } from "../../shared/utils/format";

export function Registries({ notify, closeModal }: ModalActions) {
  const [presets, setPresets] = useState<RegistryPreset[]>([]);
  const [sources, setSources] = useState<RegistrySourceSummary[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  // form
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState<RegistryPresetId>("ghcr");
  const [registry, setRegistry] = useState("");
  const [region, setRegion] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string; host?: string } | null>(null);

  const load = async () => {
    const [pres, src] = await Promise.all([http.registryPresets(), http.registrySources()]);
    if (pres.status === 200) setPresets(pres.body.items);
    if (src.status === 200) setSources(src.body.items);
  };

  useEffect(() => {
    void load();
  }, []);

  const preset = presets.find((p) => p.id === presetId);

  const reset = () => {
    setEditingId(null);
    setId("");
    setName("");
    setRegistry("");
    setRegion("");
    setUsername("");
    setPassword("");
    setEmail("");
  };

  const edit = (src: RegistrySourceSummary) => {
    setEditingId(src.id);
    setId(src.id);
    setName(src.name);
    setPresetId(src.presetId);
    setRegistry(src.registry ?? "");
    setRegion(src.region ?? "");
    setUsername(src.username);
    setEmail(src.email ?? "");
    setPassword(""); // password is never returned by the server — leave blank to preserve it
  };

  const testConnection = async () => {
    if (!username.trim()) {
      notify(t("Username is required to test the connection"), "bad");
      return;
    }
    // For an unsaved source we need the operator's password. For an editing source with a blank
    // password field, fall back to /:id/test which uses the stored value.
    setTesting(true);
    setTestResult(null);
    const res = editingId && !password
      ? await http.testSavedRegistrySource(editingId)
      : await http.testRegistrySource({
          presetId,
          registry: registry.trim() || undefined,
          region: region.trim() || undefined,
          username: username.trim(),
          password,
        });
    setTesting(false);
    if (res.status >= 400) {
      setTestResult({ ok: false, reason: apiError(res.body, res.status) });
      return;
    }
    setTestResult(res.body);
  };

  const save = async () => {
    if (!id.trim() || !name.trim() || !username.trim()) {
      notify(t("id, name and username are required"), "bad");
      return;
    }
    if (!editingId && !password) {
      notify(t("Password is required when creating a registry"), "bad");
      return;
    }
    setBusy(true);
    const res = await http.saveRegistrySource({
      id: id.trim(),
      name: name.trim(),
      presetId,
      registry: registry.trim() || undefined,
      region: region.trim() || undefined,
      username: username.trim(),
      password: password || undefined,
      email: email.trim() || undefined,
    });
    setBusy(false);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    notify(editingId ? t("Registry updated") : t("Registry added"));
    reset();
    await load();
  };

  const remove = async (sourceId: string) => {
    const res = await http.deleteRegistrySource(sourceId);
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    notify(t("Registry removed"));
    await load();
  };

  return (
    <>
      <h2 className="dialog-title">{t("Container registries")}</h2>
      <p className="dialog-description">
        {t("Save credentials once. Link a registry to a service in the Deploy form — Hyper provisions the imagePullSecret on the target namespace automatically.")}
      </p>

      <h4 className="detail-subtitle">{t("Saved registries")}</h4>
      {sources.length === 0 ? (
        <p className="text-[var(--mut)]">{t("No registries yet. Add one below.")}</p>
      ) : (
        <ul className="detail-list" aria-label={t("Saved registries")}>
          {sources.map((src) => (
            <li key={src.id} style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong>{src.name}</strong>
                <Tag>{src.presetId}</Tag>
                {src.registry ? <Tag>{src.registry}</Tag> : null}
                <Pill tone={src.secretConfigured ? "acc" : "warn"}>{src.secretConfigured ? t("configured") : t("missing secret")}</Pill>
              </div>
              <span className="text-[var(--mut)]" style={{ fontSize: 12 }}>id <code>{src.id}</code> · {src.username}</span>
              <div style={{ display: "flex", gap: 8 }}>
                <AppButton variant="ghost" onClick={() => edit(src)}>{t("Edit")}</AppButton>
                <AppButton
                  variant="ghost"
                  onClick={async () => {
                    setTesting(true);
                    setTestResult(null);
                    const res = await http.testSavedRegistrySource(src.id);
                    setTesting(false);
                    setTestResult(res.status >= 400 ? { ok: false, reason: apiError(res.body, res.status) } : res.body);
                  }}
                  disabled={testing}
                >
                  {t("Test")}
                </AppButton>
                <AppButton variant="danger" onClick={() => void remove(src.id)}>{t("Remove")}</AppButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h4 className="detail-subtitle">{editingId ? t("Edit") + " " + editingId : t("Add a registry")}</h4>
      <SelectField
        id="rs-preset"
        label={t("Registry type")}
        value={presetId}
        onChange={(v) => setPresetId(v as RegistryPresetId)}
        options={presets.map((p) => ({ value: p.id, label: p.label }))}
      />
      {preset ? (
        <p className="text-[var(--mut)]" style={{ fontSize: 12 }}>
          {t("Host pattern")}: <code>{preset.host}</code> · {t("e.g.")} <code>{preset.hostExample}</code>
          {preset.auth.hint ? <><br /><span>{preset.auth.hint}</span></> : null}
        </p>
      ) : null}
      <Field id="rs-id" label={t("ID (used as the secret suffix)")} value={id} onChange={setId} placeholder="ghcr-main" readOnly={editingId !== null} />
      <Field id="rs-name" label={t("Display name")} value={name} onChange={setName} placeholder="GHCR (acme org)" />
      {preset?.requiresRegistry ? (
        <Field id="rs-reg" label={t("Registry name")} value={registry} onChange={setRegistry} placeholder={preset.id === "acr" ? "celeste" : "harbor.example.com"} />
      ) : null}
      {preset?.id === "ecr" ? (
        <Field id="rs-region" label={t("Region")} value={region} onChange={setRegion} placeholder="us-east-1" />
      ) : null}
      <Field id="rs-user" label={preset?.auth.usernameLabel ?? t("Username")} value={username} onChange={setUsername} />
      <Field id="rs-pass" label={preset?.auth.passwordLabel ?? t("Password")} value={password} onChange={setPassword} placeholder={editingId ? t("(leave blank to keep the saved value)") : undefined} />
      <Field id="rs-email" label={t("Email (optional)")} value={email} onChange={setEmail} />

      {testResult ? (
        <p className={`template-feedback ${testResult.ok ? "ok" : "bad"}`} role="status">
          {testResult.ok
            ? `${t("Conexão OK")}${testResult.host ? ` — ${testResult.host}` : ""}`
            : `${t("Falhou")}: ${testResult.reason ?? t("erro desconhecido")}`}
        </p>
      ) : null}

      <div className="dialog-actions justify-between">
        <AppButton variant="ghost" onClick={editingId ? reset : closeModal}>{editingId ? t("Cancel edit") : t("Close")}</AppButton>
        <div className="flex gap-2">
          <AppButton variant="ghost" onClick={testConnection} disabled={testing || busy || !username.trim() || (!editingId && !password)}>
            {testing ? t("Testando…") : t("Test connection")}
          </AppButton>
          <AppButton onClick={save} disabled={busy}>{busy ? t("Saving…") : editingId ? t("Save changes") : t("Add registry")}</AppButton>
        </div>
      </div>
    </>
  );
}
