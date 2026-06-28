import type { EnvSummary } from "../../shared/types/api";
import { t } from "../../shared/i18n/t";
import { Pill } from "../atoms/Pill";
import { Tag } from "../atoms/Tag";
import { FileCode2, KeyRound } from "lucide-react";

export function EnvPanels({ env }: { env: { config: EnvSummary; secret: EnvSummary } }) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-4 border-t border-[var(--bord)] pt-6 md:grid-cols-2">
      <EnvPanel name="config.env" item={env.config} kind="config" />
      <EnvPanel name="secret.env" item={env.secret} kind="secret" />
    </div>
  );
}

function EnvPanel({ name, item, kind }: { name: string; item: EnvSummary; kind: "config" | "secret" }) {
  const EnvIcon = kind === "config" ? FileCode2 : KeyRound;
  return (
    <div className="min-w-0 rounded-[var(--radius-sm)] bg-[var(--bg)] p-4">
      <div className="flex items-center justify-between gap-2">
        <strong className="flex items-center gap-2 font-mono text-xs"><EnvIcon size={14} />{name}</strong>
        {item.exists ? <Pill tone="ok">{item.keys.length} {item.keys.length === 1 ? t("key") : t("keys")}</Pill> : <Pill tone="warn">{t("File missing")}</Pill>}
      </div>
      <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[var(--mut)]" title={item.path}>{item.path}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {item.keys.length ? item.keys.map((key) => <Tag key={key}>{key}</Tag>) : <span className="text-[var(--mut)]">{t("Empty")}</span>}
      </div>
    </div>
  );
}
