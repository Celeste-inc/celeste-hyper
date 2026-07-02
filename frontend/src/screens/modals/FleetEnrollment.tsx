import { useEffect, useState } from "react";
import { Copy, Server } from "lucide-react";
import type { EnrollmentToken, RuntimeKind } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError, fmtTs } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import { Tag } from "../../components/atoms/Tag";
import type { ModalActions, Notify } from "../types";

const runtimes: RuntimeKind[] = ["k3s", "containerd", "docker", "auto"];
const imageLoads: EnrollmentToken["imageLoad"][] = ["remote-pull", "local"];

const statusTone: Record<EnrollmentToken["status"], "ok" | "bad" | "acc" | "warn"> = {
  active: "ok",
  used: "acc",
  revoked: "bad",
  expired: "warn",
};

export function FleetEnrollment({ notify, closeModal }: ModalActions) {
  const [tokens, setTokens] = useState<EnrollmentToken[] | null>(null);
  const [name, setName] = useState("");
  const [clusterId, setClusterId] = useState("");
  const [clusterName, setClusterName] = useState("");
  const [runtime, setRuntime] = useState<RuntimeKind>("k3s");
  const [imageLoad, setImageLoad] = useState<EnrollmentToken["imageLoad"]>("remote-pull");
  const [expiresInMinutes, setExpiresInMinutes] = useState("30");
  const [minted, setMinted] = useState<{ token: string; joinCommand: string } | null>(null);

  useEffect(() => {
    http.enrollmentTokens()
      .then((result) => setTokens(result.status === 200 ? result.body.items : []))
      .catch(() => {
        setTokens([]);
        notify(t("Failed to load enrollment tokens"), "bad");
      });
  }, [notify]);

  const reload = async () => {
    const result = await http.enrollmentTokens();
    setTokens(result.body.items || []);
  };

  if (!tokens) return <><h2 className="dialog-title">{t("Add machine")}</h2><p className="text-[var(--mut)]">{t("Loading...")}</p></>;

  const create = async () => {
    if (!name.trim()) { notify(t("Token name is required"), "bad"); return; }
    if (!clusterId.trim()) { notify(t("Cluster id is required"), "bad"); return; }
    const mins = expiresInMinutes.trim();
    if (mins && (!Number.isInteger(Number(mins)) || Number(mins) <= 0)) {
      notify(t("Expiry must be a whole number of minutes"), "bad");
      return;
    }
    const result = await http.createEnrollmentToken({
      name: name.trim(),
      clusterId: clusterId.trim(),
      ...(clusterName.trim() ? { clusterName: clusterName.trim() } : {}),
      runtime,
      imageLoad,
      ...(mins ? { expiresInMinutes: Number(mins) } : {}),
    });
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    setMinted({ token: result.body.token, joinCommand: result.body.joinCommand });
    setName("");
    setClusterId("");
    setClusterName("");
    await reload();
    notify(t("Enrollment token created"));
  };

  const revoke = async (token: EnrollmentToken) => {
    if (!window.confirm(`Revoke enrollment token ${token.name}?`)) return;
    const result = await http.revokeEnrollmentToken(token.id);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    await reload();
    notify(t("Enrollment token revoked"));
  };

  return (
    <>
      <h2 className="dialog-title flex items-center gap-2"><Server size={22} />{t("Add machine")}</h2>
      <p className="dialog-description">{t("Mint a one-shot token, then run the join command on a LAN machine to enroll it as a cluster.")}</p>

      <section className="integration-section">
        {minted ? (
          <SecretBox
            title={t("Enrollment token created")}
            warning={t("Copy the join command now — the token is shown once and is single-use.")}
            rows={[{ label: t("Join command"), value: minted.joinCommand }, { label: t("Token"), value: minted.token }]}
            hint={t("Run the join command as root on the target machine. It installs k3s, pins the cert to the LAN IP, and self-registers.")}
            notify={notify}
            onDismiss={() => setMinted(null)}
          />
        ) : null}

        {tokens.length === 0 ? <p className="text-[var(--mut)]">{t("No enrollment tokens yet.")}</p> : (
          <div className="table-wrap"><table><thead><tr>
            <th>{t("Name")}</th><th>{t("Cluster")}</th><th>{t("Runtime")}</th><th>{t("Image load")}</th><th>{t("Status")}</th><th>{t("Expires")}</th><th /></tr></thead><tbody>{tokens.map((token) => (
            <tr key={token.id}>
              <td><Tag>{token.name}</Tag></td>
              <td><code>{token.clusterId}</code></td>
              <td><Pill tone="acc">{token.runtime}</Pill></td>
              <td>{token.imageLoad}</td>
              <td><Pill tone={statusTone[token.status]}>{token.status}</Pill></td>
              <td>{fmtTs(token.expiresAt)}</td>
              <td>{token.status === "active" ? <AppButton variant="danger" onClick={() => void revoke(token)}>{t("Revoke")}</AppButton> : null}</td>
            </tr>
          ))}</tbody></table></div>
        )}

        <div className="integration-form">
          <Field id="en-name" label={t("Token name")} value={name} placeholder={t("lab-edge-01")} onChange={setName} />
          <Field id="en-cid" label={t("Cluster id")} value={clusterId} placeholder={t("edge-01")} onChange={setClusterId} />
          <Field id="en-cname" label={t("Cluster name")} value={clusterName} placeholder={t("optional — defaults to the id")} onChange={setClusterName} />
          <SelectField id="en-runtime" label={t("Runtime")} value={runtime} options={runtimes.map((r) => ({ value: r, label: r }))} onChange={(v) => setRuntime(v as RuntimeKind)} />
          <SelectField id="en-iload" label={t("Image load")} value={imageLoad} options={imageLoads.map((v) => ({ value: v, label: v }))} onChange={(v) => setImageLoad(v as EnrollmentToken["imageLoad"])} />
          <Field id="en-exp" label={t("Expires in minutes")} value={expiresInMinutes} placeholder="30" onChange={setExpiresInMinutes} />
          <AppButton onClick={create}>{t("Create token")}</AppButton>
        </div>
      </section>

      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Close")}</AppButton></div>
    </>
  );
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
