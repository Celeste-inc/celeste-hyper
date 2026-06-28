import { useEffect, useState } from "react";
import { Copy, Plug } from "lucide-react";
import type { MachineToken, RegistryKind, Webhook } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError, fmtTs } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions, Notify } from "../types";

const roles: MachineToken["role"][] = ["operator", "viewer"];
const kinds: RegistryKind[] = ["dockerhub", "ghcr", "acr", "generic"];

export function Integrations({ notify, closeModal }: ModalActions) {
  const [tokens, setTokens] = useState<MachineToken[] | null>(null);
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [tokenRole, setTokenRole] = useState<MachineToken["role"]>("operator");
  const [serviceScope, setServiceScope] = useState("");
  const [clusterScope, setClusterScope] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [webhookName, setWebhookName] = useState("");
  const [webhookKind, setWebhookKind] = useState<RegistryKind>("dockerhub");
  const [webhookSvcScope, setWebhookSvcScope] = useState("");
  const [webhookCluScope, setWebhookCluScope] = useState("");
  const [newWebhook, setNewWebhook] = useState<{ secret: string; url: string } | null>(null);

  useEffect(() => {
    http.machineTokens()
      .then((result) => setTokens(result.status === 200 ? result.body.items : []))
      .catch(() => {
        setTokens([]);
        notify(t("Failed to load machine tokens"), "bad");
      });
    http.webhooks()
      .then((result) => setWebhooks(result.status === 200 ? result.body.items : []))
      .catch(() => {
        setWebhooks([]);
        notify(t("Failed to load webhooks"), "bad");
      });
  }, [notify]);

  const reloadTokens = async () => {
    const result = await http.machineTokens();
    setTokens(result.body.items || []);
  };

  const reloadWebhooks = async () => {
    const result = await http.webhooks();
    setWebhooks(result.body.items || []);
  };

  if (!tokens || !webhooks) return <><h2 className="dialog-title">{t("Integrations")}</h2><p className="text-[var(--mut)]">{t("Loading...")}</p></>;

  const createToken = async () => {
    if (!tokenName.trim()) {
      notify(t("Token name is required"), "bad");
      return;
    }
    const days = expiresInDays.trim();
    if (days && (!Number.isInteger(Number(days)) || Number(days) <= 0)) {
      notify(t("Expiry must be a whole number of days"), "bad");
      return;
    }
    const result = await http.createMachineToken({
      name: tokenName.trim(),
      role: tokenRole,
      ...(serviceScope.trim() ? { serviceScope: serviceScope.trim() } : {}),
      ...(clusterScope.trim() ? { clusterScope: clusterScope.trim() } : {}),
      ...(days ? { expiresInDays: Number(days) } : {}),
    });
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    setNewToken(result.body.token);
    setTokenName("");
    setServiceScope("");
    setClusterScope("");
    setExpiresInDays("");
    await reloadTokens();
    notify(t("Machine token created"));
  };

  const revokeToken = async (token: MachineToken) => {
    if (!window.confirm(`Revoke machine token ${token.name}? CI/CD pipelines using it will stop working.`)) return;
    const result = await http.revokeMachineToken(token.id);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    await reloadTokens();
    notify(t("Machine token revoked"));
  };

  const createWebhook = async () => {
    if (!webhookName.trim()) {
      notify(t("Webhook name is required"), "bad");
      return;
    }
    const result = await http.createWebhook({
      name: webhookName.trim(),
      kind: webhookKind,
      ...(webhookSvcScope.trim() ? { serviceScope: webhookSvcScope.trim() } : {}),
      ...(webhookCluScope.trim() ? { clusterScope: webhookCluScope.trim() } : {}),
    });
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    setNewWebhook({ secret: result.body.secret, url: result.body.webhook.url });
    setWebhookName("");
    setWebhookSvcScope("");
    setWebhookCluScope("");
    await reloadWebhooks();
    notify(t("Registry webhook created"));
  };

  const revokeWebhook = async (webhook: Webhook) => {
    if (!window.confirm(`Revoke webhook ${webhook.name}? The receiver URL will stop accepting events.`)) return;
    const result = await http.revokeWebhook(webhook.id);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    await reloadWebhooks();
    notify(t("Registry webhook revoked"));
  };

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Plug size={22} />{t("Integrations")}</h2>
      <p className="dialog-description">{t("CI/CD machine tokens and registry webhooks.")}</p>

      <section className="integration-section">
        <h3 className="integration-heading">{t("Machine tokens")}</h3>
        {newToken ? <SecretBox title={t("Machine token created")} warning={t("Copy it now — it will not be shown again.")} rows={[{ label: t("Token"), value: newToken }]} notify={notify} onDismiss={() => setNewToken(null)} /> : null}
        {tokens.length === 0 ? <p className="text-[var(--mut)]">{t("No machine tokens yet.")}</p> : (
          <div className="table-wrap"><table><thead><tr><th>{t("Name")}</th><th>{t("Role")}</th><th>{t("Scope")}</th><th>{t("Created")}</th><th>{t("Last used")}</th><th /></tr></thead><tbody>{tokens.map((token) => (
            <tr key={token.id}>
              <td><Tag>{token.name}</Tag>{token.revokedAt ? <Pill tone="bad">{t("Revoked")}</Pill> : null}</td>
              <td><Pill tone="acc">{token.role}</Pill></td>
              <td>{scopeLabel(token)}</td>
              <td>{fmtTs(token.createdAt)}</td>
              <td>{fmtTs(token.lastUsedAt)}</td>
              <td>{token.revokedAt ? null : <AppButton variant="danger" onClick={() => void revokeToken(token)}>{t("Revoke")}</AppButton>}</td>
            </tr>
          ))}</tbody></table></div>
        )}
        <div className="integration-form">
          <Field id="mt-name" label={t("Token name")} value={tokenName} placeholder={t("github-actions")} onChange={setTokenName} />
          <SelectField id="mt-role" label={t("Role")} value={tokenRole} options={roles.map((item) => ({ value: item, label: item }))} onChange={(value) => setTokenRole(value as MachineToken["role"])} />
          <Field id="mt-svc" label={t("Service scope")} value={serviceScope} placeholder={t("optional — blank for all")} onChange={setServiceScope} />
          <Field id="mt-cluster" label={t("Cluster scope")} value={clusterScope} placeholder={t("optional — blank for all")} onChange={setClusterScope} />
          <Field id="mt-exp" label={t("Expires in days")} value={expiresInDays} placeholder={t("optional — blank for no expiry")} onChange={setExpiresInDays} />
          <AppButton onClick={createToken}>{t("Create token")}</AppButton>
        </div>
      </section>

      <section className="integration-section">
        <h3 className="integration-heading">{t("Registry webhooks")}</h3>
        {newWebhook ? <SecretBox title={t("Registry webhook created")} warning={t("Copy the secret now — it will not be shown again.")} rows={[{ label: t("Receiver URL"), value: newWebhook.url }, { label: t("HMAC secret"), value: newWebhook.secret }]} hint={t("Point your registry's webhook at this URL and sign the body with HMAC-SHA256 using this secret (header X-Hub-Signature-256: sha256=<hex>).")} notify={notify} onDismiss={() => setNewWebhook(null)} /> : null}
        {webhooks.length === 0 ? <p className="text-[var(--mut)]">{t("No registry webhooks yet.")}</p> : (
          <div className="table-wrap"><table><thead><tr><th>{t("Name")}</th><th>{t("Kind")}</th><th>{t("Receiver URL")}</th><th>{t("Created")}</th><th>{t("Last used")}</th><th /></tr></thead><tbody>{webhooks.map((webhook) => (
            <tr key={webhook.id}>
              <td><Tag>{webhook.name}</Tag>{webhook.revokedAt ? <Pill tone="bad">{t("Revoked")}</Pill> : null}</td>
              <td><Pill tone="acc">{webhook.kind}</Pill></td>
              <td><code className="endpoint-url">{webhook.url}</code></td>
              <td>{fmtTs(webhook.createdAt)}</td>
              <td>{fmtTs(webhook.lastUsedAt)}</td>
              <td>{webhook.revokedAt ? null : <AppButton variant="danger" onClick={() => void revokeWebhook(webhook)}>{t("Revoke")}</AppButton>}</td>
            </tr>
          ))}</tbody></table></div>
        )}
        <div className="integration-form">
          <Field id="wh-name" label={t("Webhook name")} value={webhookName} placeholder={t("dockerhub-prod")} onChange={setWebhookName} />
          <SelectField id="wh-kind" label={t("Kind")} value={webhookKind} options={kinds.map((item) => ({ value: item, label: item }))} onChange={(value) => setWebhookKind(value as RegistryKind)} />
          <Field id="wh-svc" label={t("Service scope")} value={webhookSvcScope} placeholder={t("optional — bind to one service")} onChange={setWebhookSvcScope} />
          <Field id="wh-clu" label={t("Cluster scope")} value={webhookCluScope} placeholder={t("optional — bind to one cluster")} onChange={setWebhookCluScope} />
          <AppButton onClick={createWebhook}>{t("Create webhook")}</AppButton>
        </div>
      </section>

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
}

function scopeLabel(token: MachineToken): string {
  const parts: string[] = [];
  if (token.serviceScope) parts.push(`service: ${token.serviceScope}`);
  if (token.clusterScope) parts.push(`cluster: ${token.clusterScope}`);
  return parts.length ? parts.join(" · ") : t("all");
}

function SecretBox({ title, warning, rows, hint, notify, onDismiss }: { title: string; warning: string; rows: { label: string; value: string }[]; hint?: string; notify: Notify; onDismiss: () => void }) {
  const copy = async (value: string) => {
    try {
      await copyText(value);
      notify(t("Copied"));
    } catch {
      notify(t("Could not copy"), "bad");
    }
  };

  return (
    <div className="secret-box">
      <strong className="secret-title">{title}</strong>
      <p className="secret-warn">{warning}</p>
      {rows.map((row) => (
        <div key={row.label} className="secret-row">
          <span className="secret-label">{row.label}</span>
          <code className="secret-value">{row.value}</code>
          <button className="icon-button" type="button" aria-label={`${t("Copy")} ${row.label}`} onClick={() => void copy(row.value)}><Copy size={16} /></button>
        </div>
      ))}
      {hint ? <p className="secret-hint">{hint}</p> : null}
      <AppButton variant="ghost" onClick={onDismiss}>{t("Dismiss")}</AppButton>
    </div>
  );
}

async function copyText(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy command failed");
}
