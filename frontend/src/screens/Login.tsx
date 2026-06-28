import { useState, type FormEvent } from "react";
import { CircleAlert, LogIn, UserRound } from "lucide-react";
import { http } from "../shared/api/client";
import { t } from "../shared/i18n/t";
import { AppButton } from "../components/atoms/AppButton";
import { AuthPasswordField, AuthShell, AuthTextField } from "../components/molecules/AuthShell";

type Theme = "light" | "dark";

export function Login({ onAuthed, theme, onToggleTheme }: { onAuthed: () => void; theme?: Theme; onToggleTheme?: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await http.login(username, password);
      if (res.status === 200) {
        onAuthed();
        return;
      }
      setError(res.body?.error ?? t("Login failed"));
    } catch {
      setError(t("Unable to reach the control plane. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell eyebrow={t("Control plane access")} title={t("Welcome back")} description={t("Sign in to manage clusters, services, and deployments.")} icon={<LogIn size={24} />} theme={theme} onToggleTheme={onToggleTheme}>
      <form className="auth-form" aria-label={t("Sign in")} onSubmit={submit}>
        <AuthTextField id="username" label={t("Username")} value={username} autoComplete="username" placeholder={t("admin")} icon={<UserRound size={17} />} autoFocus disabled={busy} onChange={setUsername} />
        <AuthPasswordField id="password" label={t("Password")} value={password} autoComplete="current-password" placeholder={t("Enter your password")} disabled={busy} onChange={setPassword} />
        {error ? <p role="alert" className="auth-error"><CircleAlert size={15} />{error}</p> : null}
        <AppButton className="auth-submit" type="submit" disabled={busy || !username || !password}>{busy ? t("Signing in…") : t("Sign in")}</AppButton>
      </form>
    </AuthShell>
  );
}
