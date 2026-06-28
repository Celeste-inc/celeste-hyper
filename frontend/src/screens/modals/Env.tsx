import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  Eye,
  EyeOff,
  FileCode2,
  FilePlus2,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { EnvKind, EnvRow, EnvSummary } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { AppButton } from "../../components/atoms/AppButton";
import { t } from "../../shared/i18n/t";
import type { ModalActions } from "../types";

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Minimal dotenv → rows parse for paste-import and config content (backend is authoritative on save). */
function parseDotenv(text: string): EnvRow[] {
  const rows: EnvRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    rows.push({ key, value });
  }
  return rows;
}

function duplicateKeys(rows: EnvRow[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

export function Env({ name, kind, notify, closeModal, load }: ModalActions & { name: string; kind: EnvKind }) {
  const [summary, setSummary] = useState<EnvSummary | null>(null);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [originalKeys, setOriginalKeys] = useState<string[]>([]);
  const [reveal, setReveal] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteContent, setPasteContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const EnvIcon = kind === "config" ? FileCode2 : KeyRound;

  useEffect(() => {
    let active = true;
    setSummary(null);
    setRows([]);
    setOriginalKeys([]);
    setReveal(false);
    setPasteOpen(false);
    setPasteContent("");
    setLoadError(false);
    void http.env(name, kind).then((result) => {
      if (!active) return;
      if (result.status >= 400) {
        setLoadError(true);
        return;
      }
      setSummary(result.body);
      setOriginalKeys(result.body.keys || []);
      if (kind === "config" && result.body.content) {
        setRows(parseDotenv(result.body.content));
        return;
      }
      const source: { key: string; description?: string }[] = result.body.rows ?? result.body.keys.map((key) => ({ key }));
      setRows(source.map((row) => ({ key: row.key, value: "", description: row.description })));
    }).catch(() => {
      if (active) setLoadError(true);
    });
    return () => {
      active = false;
    };
  }, [name, kind]);

  const setRow = (i: number, patch: Partial<EnvRow>) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { key: "", value: "" }]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  const importPaste = () => {
    const importedRows = parseDotenv(pasteContent);
    if (!importedRows.length) {
      notify(t("No valid environment variables found"), "bad");
      return;
    }
    setRows(importedRows);
    setPasteContent("");
    setPasteOpen(false);
  };

  const removedKeys = useMemo(() => originalKeys.filter((k) => !rows.some((r) => r.key === k)), [originalKeys, rows]);
  const invalidKeys = rows.filter((r) => r.key && !KEY_RE.test(r.key)).map((r) => r.key);
  const repeatedKeys = useMemo(() => duplicateKeys(rows), [rows]);

  const save = async () => {
    if (invalidKeys.length) {
      notify(`Invalid key(s): ${invalidKeys.join(", ")}`, "bad");
      return;
    }
    if (repeatedKeys.length) {
      notify(`Duplicate key(s): ${repeatedKeys.join(", ")}`, "bad");
      return;
    }
    if (removedKeys.length && !window.confirm(`Remove ${removedKeys.length} key(s): ${removedKeys.join(", ")}?`)) return;
    const payload = rows.filter((r) => r.key.trim()).map((r) => ({ ...r, key: r.key.trim() }));
    setBusy(true);
    try {
      const result = await http.saveEnvRows(name, kind, payload);
      if (result.status >= 400) {
        notify(apiError(result.body, result.status), "bad");
        return;
      }
      closeModal();
      notify(result.body.stripped?.length ? `Saved (stripped control chars in ${result.body.stripped.join(", ")})` : t("Environment saved"));
      await load();
    } catch {
      notify(t("Unable to save the environment file"), "bad");
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="env-editor env-editor-state">
        <span className="env-state-icon env-state-icon-error"><AlertTriangle size={22} /></span>
        <h2>{t("Could not load environment file")}</h2>
        <p>{t("Close this window and try again.")}</p>
        <AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton>
      </section>
    );
  }

  if (!summary) {
    return (
      <section className="env-editor env-editor-state" aria-busy="true">
        <span className="env-state-icon"><LoaderCircle className="spin" size={22} /></span>
        <h2>{name} · {kind}.env</h2>
        <p>{t("Loading environment file…")}</p>
      </section>
    );
  }

  return (
    <section className="env-editor">
      <header className="env-editor-header">
        <span className={`env-editor-icon ${kind === "secret" ? "secret" : ""}`} aria-hidden="true"><EnvIcon size={22} /></span>
        <div className="env-editor-heading">
          <p>{kind === "secret" ? t("Protected environment") : t("Runtime configuration")}</p>
          <h2 className="dialog-title">{kind}.env</h2>
          <span>{t("Service")} <strong>{name}</strong></span>
        </div>
        <span className={`env-file-status ${summary.exists ? "exists" : "new"}`}>
          {summary.exists ? <Check size={13} /> : <FilePlus2 size={13} />}
          {summary.exists ? t("File exists") : t("New file")}
        </span>
      </header>

      <div className="env-file-path">
        <span>{t("File path")}</span>
        <code title={summary.path}>{summary.path}</code>
      </div>

      {kind === "secret" ? (
        <div className="env-security-note">
          <span aria-hidden="true"><ShieldCheck size={18} /></span>
          <div>
            <strong>{t("Secret values stay protected")}</strong>
            <p>{t("Stored values are never sent to the browser. Leave a value blank to keep the existing secret unchanged.")}</p>
          </div>
        </div>
      ) : null}

      <div className="env-toolbar">
        <div>
          <strong>{t("Environment variables")}</strong>
          <span>{rows.length} {rows.length === 1 ? t("variable") : t("variables")}</span>
        </div>
        <div className="env-toolbar-actions">
          {kind === "secret" ? (
            <AppButton variant="ghost" onClick={() => setReveal((visible) => !visible)}>
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
              {reveal ? t("Hide values") : t("Show values")}
            </AppButton>
          ) : null}
          <AppButton variant="ghost" onClick={() => setPasteOpen((open) => !open)}>
            <ClipboardPaste size={15} />{t("Import")}
          </AppButton>
          <AppButton variant="ghost" onClick={addRow}><Plus size={15} />{t("Add variable")}</AppButton>
        </div>
      </div>

      {pasteOpen ? (
        <div className="env-import-panel">
          <div className="env-import-heading">
            <div>
              <strong>{t("Import dotenv content")}</strong>
              <span>{t("This will replace the variables currently shown below.")}</span>
            </div>
            <button type="button" className="icon-button" aria-label={t("Close import")} onClick={() => setPasteOpen(false)}><X size={15} /></button>
          </div>
          <textarea className="hyper-input" aria-label={t("Dotenv content")} placeholder={"API_URL=https://api.example.com\nLOG_LEVEL=info"} value={pasteContent} onChange={(event) => setPasteContent(event.target.value)} />
          <div className="env-import-actions">
            <AppButton variant="ghost" onClick={() => setPasteOpen(false)}>{t("Cancel")}</AppButton>
            <AppButton disabled={!pasteContent.trim()} onClick={importPaste}><ClipboardPaste size={15} />{t("Replace variables")}</AppButton>
          </div>
        </div>
      ) : null}

      {rows.length ? (
        <div className="env-variable-list" aria-label={t("environment variables")}>
          <div className="env-column-headings" aria-hidden="true">
            <span />
            <span>{t("Variable name")}</span>
            <span>{kind === "secret" ? t("Secret value") : t("Value")}</span>
            <span />
          </div>
          {rows.map((row, index) => {
            const invalid = Boolean(row.key && !KEY_RE.test(row.key));
            const duplicate = Boolean(row.key && repeatedKeys.includes(row.key.trim()));
            return (
              <div className={`env-row ${invalid || duplicate ? "has-error" : ""}`} key={index}>
                <span className="env-row-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <label>
                  <span>{t("Variable name")}</span>
                  <input aria-label={`key ${index}`} className="hyper-input env-key-input" autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder={t("VARIABLE_NAME")} value={row.key} onChange={(event) => setRow(index, { key: event.target.value })} />
                  {invalid ? <small>{t("Use uppercase letters, numbers, and underscores.")}</small> : null}
                  {duplicate ? <small>{t("Variable names must be unique.")}</small> : null}
                </label>
                <label>
                  <span>{kind === "secret" ? t("Secret value") : t("Value")}</span>
                  <input aria-label={`value ${index}`} className="hyper-input env-value-input" type={kind === "secret" && !reveal ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={kind === "secret" && originalKeys.includes(row.key) ? t("Leave blank to keep current value") : t("Enter value")} value={row.value} onChange={(event) => setRow(index, { value: event.target.value })} />
                </label>
                <button type="button" className="env-remove-button" aria-label={`remove ${row.key || index}`} onClick={() => removeRow(index)}><Trash2 size={16} /></button>
                {row.description ? <p className="env-row-description">{row.description}</p> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="env-empty-state">
          <span aria-hidden="true"><EnvIcon size={21} /></span>
          <strong>{t("No variables yet")}</strong>
          <p>{t("Add variables individually or import existing dotenv content.")}</p>
          <AppButton variant="ghost" onClick={addRow}><Plus size={15} />{t("Add first variable")}</AppButton>
        </div>
      )}

      {removedKeys.length ? (
        <div className="env-change-warning">
          <AlertTriangle size={16} />
          <div><strong>{t("Keys marked for removal")}</strong><p>{removedKeys.join(", ")}</p></div>
        </div>
      ) : null}

      <footer className="env-editor-actions">
        <span>{t("Changes are applied when you save.")}</span>
        <div>
          <AppButton variant="ghost" disabled={busy} onClick={closeModal}>{t("Cancel")}</AppButton>
          <AppButton disabled={busy || Boolean(invalidKeys.length) || Boolean(repeatedKeys.length)} onClick={() => void save()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            {busy ? t("Saving…") : t("Save changes")}
          </AppButton>
        </div>
      </footer>
    </section>
  );
}
