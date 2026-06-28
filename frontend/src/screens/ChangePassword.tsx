import { useState, type FormEvent } from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";
import { http } from "../shared/api/client";
import { AppButton } from "../components/atoms/AppButton";
import { AuthPasswordField, AuthShell } from "../components/molecules/AuthShell";
import { t } from "../shared/i18n/t";

type Theme = "light" | "dark";

export function ChangePassword({ onChanged, theme, onToggleTheme }: { onChanged: () => void; theme?: Theme; onToggleTheme?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < 8) {
      setError(t("Your new password must contain at least 8 characters."));
      return;
    }
    if (next !== confirmation) {
      setError(t("The new passwords do not match."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await http.changePassword(current, next);
      if (res.status === 200) {
        onChanged();
        return;
      }
      setError(res.body?.error ?? t("Could not change password"));
    } catch {
      setError(t("Unable to reach the control plane. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell eyebrow={t("Account security")} title={t("Secure your account")} description={t("Replace the temporary password before entering the control plane.")} icon={<ShieldCheck size={25} />} theme={theme} onToggleTheme={onToggleTheme}>
      <form className="auth-form" aria-label={t("Change password")} onSubmit={submit}>
        <AuthPasswordField id="current" label={t("Current password")} value={current} autoComplete="current-password" placeholder={t("Temporary password")} autoFocus disabled={busy} onChange={setCurrent} />
        <div className="auth-divider" />
        <AuthPasswordField id="next" label={t("New password")} value={next} autoComplete="new-password" placeholder={t("At least 8 characters")} disabled={busy} onChange={setNext} />
        <AuthPasswordField id="confirmation" label={t("Confirm new password")} value={confirmation} autoComplete="new-password" placeholder={t("Enter it again")} disabled={busy} onChange={setConfirmation} />
        <p className="auth-hint"><ShieldCheck size={13} />{t("Use at least 8 characters and avoid reusing a password.")}</p>
        {error ? <p role="alert" className="auth-error"><CircleAlert size={15} />{error}</p> : null}
        <AppButton className="auth-submit" type="submit" disabled={busy || !current || !next || !confirmation}>{busy ? t("Saving…") : t("Set new password")}</AppButton>
      </form>
    </AuthShell>
  );
}
