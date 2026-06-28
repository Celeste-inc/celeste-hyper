import { t } from "../../shared/i18n/t";

/** Read the `?ns=a,b` selection from the current URL. */
export function readNamespacesFromUrl(): string[] {
  const raw = new URLSearchParams(window.location.search).get("ns");
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Persist the namespace selection to the URL (no history entry). */
export function writeNamespacesToUrl(namespaces: string[]): void {
  const params = new URLSearchParams(window.location.search);
  if (namespaces.length) params.set("ns", namespaces.join(","));
  else params.delete("ns");
  const qs = params.toString();
  window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
}

/** Apply a namespace selection to any list of `{ namespace }` items (empty selection = all). */
export function filterByNamespace<T extends { namespace: string }>(items: T[], selected: string[]): T[] {
  if (selected.length === 0) return items;
  const set = new Set(selected);
  return items.filter((item) => set.has(item.namespace));
}

export function NamespaceFilter({
  namespaces,
  selected,
  onChange,
}: {
  namespaces: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (namespaces.length <= 1) return null; // nothing meaningful to filter
  const toggle = (ns: string) =>
    onChange(selected.includes(ns) ? selected.filter((n) => n !== ns) : [...selected, ns]);
  return (
    <div className="ns-filter" role="group" aria-label={t("Filter by namespace")}>
      {namespaces.map((ns) => (
        <button
          key={ns}
          type="button"
          aria-pressed={selected.includes(ns)}
          className={selected.includes(ns) ? "chip active" : "chip"}
          onClick={() => toggle(ns)}
        >
          {ns}
        </button>
      ))}
      {selected.length > 0 ? (
        <button type="button" className="chip" onClick={() => onChange([])}>
          {t("Clear")}
        </button>
      ) : null}
    </div>
  );
}
