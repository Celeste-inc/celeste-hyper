import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import { isAuthCarveout, type Principal } from "./auth.ts";
import { isMutation } from "./role-map.ts";
import { recordAudit, queryAudit } from "../lib/audit.ts";
import { log } from "../lib/logger.ts";

// Mutations on these paths are noisy or self-service and aren't worth an audit row.
const SKIP_AUDIT = [/^\/api\/logout$/, /^\/api\/services\/[^/]+\/logs\/token$/];

function parseResource(path: string): { kind: string | null; id: string | null } {
  const m = /^\/api\/([^/]+)(?:\/([^/]+))?/.exec(path);
  if (!m) return { kind: null, id: null };
  const id = m[2] ? decodeURIComponent(m[2]) : null;
  return { kind: m[1] ?? null, id };
}

/**
 * Record one audit row for an HTTP mutation, called from the `onAfterResponse` hook so it sees the
 * final status (success, validation failure, or a guard 401/403 denial). Reads (GET/HEAD) are not
 * audited. The request body is never logged — only the method, path-derived resource, actor, and
 * outcome — so secrets in bodies (passwords, env values, tokens) never reach the trail.
 */
export function recordHttpAudit(deps: ApiDeps, request: Request, principal: Principal | null, status: number | string | undefined): void {
  const method = request.method;
  if (!isMutation(method)) return;
  // Only audit AUTHENTICATED requests. An anonymous/expired-token mutation is rejected 401 by the
  // guard; auditing it would let an unauthenticated client append rows (write-amplification DoS that
  // takes the single SQLite writer). A 403 (a real user forbidden) still has a principal → audited.
  if (!principal) return;
  const path = new URL(request.url).pathname;
  // Carve-outs (login/logs-stream/webhook-receiver) have no resolved principal here; login is logged
  // separately and webhook-triggered deploys are audited by the worker, so skip them.
  if (isAuthCarveout(path)) return;
  if (SKIP_AUDIT.some((re) => re.test(path))) return;
  // set.status is a numeric code (handlers use `status(code, …)`); a bare object response leaves it
  // undefined → 200.
  const code = typeof status === "number" ? status : Number.isFinite(Number(status)) ? Number(status) : 200;
  const { kind, id } = parseResource(path);
  try {
    recordAudit(
      deps.state,
      {
        actor: principal.username,
        role: principal.role,
        action: `${method} ${path}`,
        resourceKind: kind,
        resourceId: id,
        result: code < 400 ? "ok" : "fail",
        message: code >= 400 ? `HTTP ${code}` : null,
      },
      deps.clock.now(),
    );
  } catch (e) {
    // Auditing must never break the request it follows.
    log.error("audit.record_failed", { path, error: (e as Error).message });
  }
}

const QuerySchema = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  actor: z.string().optional(),
  action: z.string().optional(),
  resource_kind: z.string().optional(),
  result: z.enum(["ok", "fail"]).optional(),
  page_size: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const auditRoutes = (deps: ApiDeps) =>
  new Elysia().get(
    "/audit",
    ({ query, status }) => {
      const parsed = QuerySchema.safeParse(query ?? {});
      if (!parsed.success) return status(422, { error: "invalid query", issues: parsed.error.issues });
      const q = parsed.data;
      return queryAudit(deps.state, {
        since: q.since,
        until: q.until,
        actor: q.actor,
        action: q.action,
        resourceKind: q.resource_kind,
        result: q.result,
        pageSize: q.page_size,
        cursor: q.cursor,
      });
    },
    { detail: { summary: "Query the audit trail (cursor-paginated, newest first)", tags: ["audit"] } },
  );
