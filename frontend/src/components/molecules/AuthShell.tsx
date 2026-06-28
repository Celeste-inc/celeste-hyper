import { useState, type ReactNode } from "react";
import { Cloud, Eye, EyeOff, LockKeyhole, Moon, Sun } from "lucide-react";
import { t } from "../../shared/i18n/t";

type Theme = "light" | "dark";

interface AuthShellProps {
  eyebrow: string;
  title: string;
  description: string;
  icon: ReactNode;
  theme?: Theme;
  onToggleTheme?: () => void;
  children: ReactNode;
}

export function AuthShell({ eyebrow, title, description, icon, theme, onToggleTheme, children }: AuthShellProps) {
  return (
    <main className="auth-shell">
      <header className="auth-header">
        <div className="auth-nav">
          <div className="auth-brand">
            <span className="brand-mark" aria-hidden="true"><Cloud size={16} /></span>
            <strong>Celeste Hyper</strong>
          </div>
          {onToggleTheme ? (
            <button className="theme-toggle" type="button" aria-label={theme === "dark" ? t("Switch to light mode") : t("Switch to dark mode")} onClick={onToggleTheme}>
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          ) : null}
        </div>
      </header>

      <section className="auth-stage">
        <div className="auth-card">
          <div className="auth-icon" aria-hidden="true">{icon}</div>
          <p className="auth-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="auth-description">{description}</p>
          {children}
          <footer className="auth-footer"><LockKeyhole size={12} />{t("Private control plane · Secure session")}</footer>
        </div>
      </section>
    </main>
  );
}

interface AuthFieldProps {
  id: string;
  label: string;
  value: string;
  autoComplete: string;
  icon: ReactNode;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function AuthTextField({ id, label, value, autoComplete, icon, placeholder, autoFocus, disabled, onChange }: AuthFieldProps) {
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <span className="auth-input-wrap">
        <span className="auth-input-icon" aria-hidden="true">{icon}</span>
        <input
          id={id}
          className="auth-input"
          value={value}
          autoComplete={autoComplete}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    </div>
  );
}

export function AuthPasswordField(props: Omit<AuthFieldProps, "icon">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-field">
      <label htmlFor={props.id}>{props.label}</label>
      <span className="auth-input-wrap">
        <span className="auth-input-icon" aria-hidden="true"><LockKeyhole size={17} /></span>
        <input
          id={props.id}
          type={visible ? "text" : "password"}
          className="auth-input auth-input-password"
          value={props.value}
          autoComplete={props.autoComplete}
          placeholder={props.placeholder}
          autoFocus={props.autoFocus}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <button className="auth-reveal" type="button" aria-label={visible ? `Hide ${props.label.toLowerCase()}` : `Show ${props.label.toLowerCase()}`} disabled={props.disabled} onClick={() => setVisible((current) => !current)}>
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
    </div>
  );
}
