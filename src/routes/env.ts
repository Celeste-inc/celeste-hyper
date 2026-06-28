import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import * as envFiles from "../lib/env-files.ts";
import { log } from "../lib/logger.ts";

const EnvBody = z.object({ content: z.string() });
const RowsBody = z.object({
  rows: z
    .array(z.object({ key: z.string().max(256), value: z.string().max(65_536), description: z.string().max(2_048).optional() }))
    .max(1000),
});
const tags = ["env"];

/** Parse stored env content, tolerating a malformed file (e.g. a pre-existing duplicate). */
function safeParseStored(content: string): envFiles.EnvRow[] {
  try {
    return envFiles.parseRows(content);
  } catch {
    return [];
  }
}

export const envRoutes = (deps: ApiDeps) =>
  new Elysia()
    .get(
      "/services/:name/env/:kind",
      async ({ params, query, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const kind = params.kind;
        if (kind !== "config" && kind !== "secret") return status(400, { error: "kind must be config|secret" });
        const reveal = query.reveal === "true";
        const summary = await envFiles.summary(deps.cfg.envFilesDir, svc.name, kind);
        if (!reveal || kind === "secret") return summary;
        const content = await envFiles.read(deps.cfg.envFilesDir, svc.name, kind);
        return { ...summary, content };
      },
      { detail: { summary: "Read an env file summary (config|secret)", tags } },
    )
    .put(
      "/services/:name/env/:kind",
      async ({ params, body, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const kind = params.kind;
        if (kind !== "config" && kind !== "secret") return status(400, { error: "kind must be config|secret" });
        const parsed = EnvBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        await envFiles.write(deps.cfg.envFilesDir, svc.name, kind, parsed.data.content);
        log.info("api.env_updated", { service: svc.name, kind });
        return { ok: true };
      },
      { detail: { summary: "Replace an env file from raw content (config|secret) — deprecated; use /rows", tags, deprecated: true } },
    )
    .put(
      "/services/:name/env/:kind/rows",
      async ({ params, body, status }) => {
        const svc = deps.registry.get(params.name);
        if (!svc) return status(404, { error: "service not found" });
        const kind = params.kind;
        if (kind !== "config" && kind !== "secret") return status(400, { error: "kind must be config|secret" });
        const parsed = RowsBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const errors = envFiles.rowErrors(parsed.data.rows);
        if (errors.length) return status(422, { error: "invalid rows", issues: errors });
        let rows = parsed.data.rows;
        if (kind === "secret") {
          // Secret values never round-trip to the browser, so the editor sends blank values for
          // untouched keys. A blank value here means "keep the stored secret" — merge server-side.
          const stored = new Map(safeParseStored(await envFiles.read(deps.cfg.envFilesDir, svc.name, kind)).map((r) => [r.key, r.value]));
          rows = rows.map((r) => (r.value === "" && stored.has(r.key) ? { ...r, value: stored.get(r.key)! } : r));
        }
        const { content, stripped } = envFiles.serializeRows(rows);
        await envFiles.write(deps.cfg.envFilesDir, svc.name, kind, content);
        log.info("api.env_updated", { service: svc.name, kind, rows: parsed.data.rows.length });
        return { ok: true, stripped };
      },
      { detail: { summary: "Replace an env file from structured rows (config|secret)", tags } },
    );
