import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "../../shared/i18n/t";

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true">
        <button ref={closeButtonRef} className="hyper-button ghost absolute right-4 top-4 min-h-8 w-8 p-0" type="button" aria-label={t("Close dialog")} onClick={onClose}><X size={16} /></button>
        {children}
      </div>
    </div>
  );
}
