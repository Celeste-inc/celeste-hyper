import type { ReactNode } from "react";

export type PillTone = "ok" | "bad" | "warn" | "acc" | "pending" | "downloading" | "applying" | "done" | "failed";

export function Pill({ children, tone = "acc", title, className = "" }: { children: ReactNode; tone?: PillTone | string; title?: string; className?: string }) {
  return <span className={`pill ${tone} ${className}`.trim()} title={title}>{children}</span>;
}
