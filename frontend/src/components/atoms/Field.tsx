import type { ChangeEventHandler, ReactNode } from "react";

interface FieldProps {
  id: string;
  label: string;
  value: string;
  hint?: string;
  placeholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  multiline?: boolean;
  children?: ReactNode;
  onChange: (value: string) => void;
}

export function Field({ id, label, value, hint, placeholder, readOnly, autoFocus, multiline, children, onChange }: FieldProps) {
  const handleChange: ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement> = (event) => onChange(event.target.value);
  return (
    <div className="mb-4">
      <label className="mb-1.5 block text-xs font-semibold text-[var(--fg)]" htmlFor={id}>{label}</label>
      {children ?? (multiline ? (
        <textarea id={id} className="hyper-input" value={value} placeholder={placeholder} readOnly={readOnly} autoFocus={autoFocus} spellCheck={false} onChange={handleChange} />
      ) : (
        <input id={id} className="hyper-input" value={value} placeholder={placeholder} readOnly={readOnly} autoFocus={autoFocus} autoComplete="off" onChange={handleChange} />
      ))}
      {hint ? <span className="mt-1 block text-[11px] text-[var(--mut)]">{hint}</span> : null}
    </div>
  );
}

export function SelectField({ id, label, value, hint, options, onChange }: { id: string; label: string; value: string; hint?: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <div className="mb-4">
      <label className="mb-1.5 block text-xs font-semibold text-[var(--fg)]" htmlFor={id}>{label}</label>
      <select id={id} className="hyper-input" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {hint ? <span className="mt-1 block text-[11px] text-[var(--mut)]">{hint}</span> : null}
    </div>
  );
}
