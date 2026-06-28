import type { ReactNode } from "react";

export function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="tag" title={title}>{children}</span>;
}
