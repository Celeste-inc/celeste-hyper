import { useEffect } from "react";

export interface ToastState {
  message: string;
  kind?: "bad";
}

export function Toast({ toast, onDone }: { toast: ToastState | null; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(onDone, 4000);
    return () => window.clearTimeout(timer);
  }, [toast, onDone]);

  if (!toast) return null;
  return <div className={`fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-full bg-[var(--fg)] px-4 py-3 font-semibold text-[var(--bg)] shadow-[var(--modal-shadow)] ${toast.kind === "bad" ? "text-[var(--bad)]" : ""}`}>{toast.message}</div>;
}
