import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "../../shared/i18n/t";

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const syncAccessibleName = () => {
      const card = cardRef.current;
      if (!card) return;
      const heading = card.querySelector<HTMLElement>("h1, h2, h3");
      if (!heading) return;
      heading.id = titleId;
      card.setAttribute("aria-labelledby", titleId);
      card.removeAttribute("aria-label");
    };
    syncAccessibleName();
    const labelObserver = new MutationObserver(syncAccessibleName);
    if (cardRef.current) labelObserver.observe(cardRef.current, { childList: true, subtree: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !cardRef.current) return;
      const focusable = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      labelObserver.disconnect();
      previousFocus?.focus();
    };
  }, [onClose, titleId]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={cardRef} className="modal-card" role="dialog" aria-modal="true" aria-label={t("Dialog")}>
        <button ref={closeButtonRef} className="modal-close hyper-button ghost" type="button" aria-label={t("Close dialog")} onClick={onClose}><X size={16} /></button>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}
