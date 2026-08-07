const NEEDS_QUOTE = /[:#\[\]{}&*!?,><=%@`'"\n\t]|^\s|\s$|^(true|false|null|yes|no|on|off|~|-)$/i;

function quoteIfNeeded(s: string): string {
  if (s === "") return '""';
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return `"${s}"`; // numeric-looking strings (e.g. "1.27") must be quoted
  if (NEEDS_QUOTE.test(s)) return JSON.stringify(s);
  return s;
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function renderValue(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return quoteIfNeeded(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "\n" + value.map((item) => `${indent(depth)}- ${renderItem(item, depth + 1)}`).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return "\n" + entries
      .map(([k, v]) => {
        const rendered = renderValue(v, depth + 1);
        return `${indent(depth)}${k}: ${rendered.startsWith("\n") ? rendered.trimStart() && rendered : rendered}`;
      })
      .join("\n");
  }
  return JSON.stringify(value);
}

function renderItem(value: unknown, depth: number): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v], i) => {
        const rendered = renderValue(v, depth + 1);
        const prefix = i === 0 ? "" : indent(depth);
        return `${prefix}${k}: ${rendered.startsWith("\n") ? rendered.trimStart() && rendered : rendered}`;
      })
      .join("\n");
  }
  return renderValue(value, depth);
}

/** Minimal YAML 1.2 stringifier for Kubernetes manifests (block style, double-quoted strings). */
export function stringify(value: unknown): string {
  const out = renderValue(value, 0).trimStart();
  return out.endsWith("\n") ? out : out + "\n";
}
