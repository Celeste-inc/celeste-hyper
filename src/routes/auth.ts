import { Elysia } from "elysia";
import { z } from "zod";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiDeps } from "./deps.ts";
import { signJwt, verifyJwt } from "../lib/jwt.ts";
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "../lib/password.ts";
import { looksLikeMachineToken, hashMachineToken } from "../lib/machine-token.ts";
import { log } from "../lib/logger.ts";

const COOKIE_NAME = "hyper_session";
const TTL_SEC = 12 * 60 * 60;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const MIN_PASSWORD_LEN = 8;

/** `/api/*` paths the global guard skips. `/api/enroll` (P4.1) self-authenticates with the one-shot
 *  enrollment token in its body — the worker has no session/bearer — like the webhook receiver. */
const CARVEOUTS = new Set(["/api/health", "/api/login", "/api/version", "/api/enroll"]);
// The log STREAM (GET) self-authenticates (one-shot ?logToken= or cookie/bearer); `.../logs/token`
// (POST, mints a token) is NOT matched here and stays behind the guard.
const LOGS_STREAM = /^\/api\/services\/[^/]+\/logs$/;
// Registry webhook receiver (P1.10) authenticates by the unguessable :secretId in the URL + an HMAC
// signature on the body, not by a bearer/cookie — so it bypasses the session guard (the route's own
// handler verifies the secretId + signature). The management CRUD under /api/webhooks stays guarded.
const WEBHOOK_RECEIVER = /^\/api\/webhooks\/registry\/[^/]+$/;
// The exec terminal WS (P3.2) self-authenticates via a one-shot ?token (browser WS can't send an
// Authorization header), exactly like the logs stream; the token mint stays behind the guard.
const EXEC_WS = /^\/api\/services\/[^/]+\/exec$/;
export function isAuthCarveout(path: string): boolean {
  return CARVEOUTS.has(path) || LOGS_STREAM.test(path) || WEBHOOK_RECEIVER.test(path) || EXEC_WS.test(path);
}

/** Constant-time CSRF token comparison (length-guarded so timingSafeEqual never throws). */
export function csrfEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Principal {
  username: string;
  role: string;
  /** Per-session CSRF token (from the JWT `csrf` claim); null for legacy tokens. */
  csrf: string | null;
  /** Whether the token came from the cookie (CSRF-checked) or a bearer header (exempt). */
  source: "bearer" | "cookie";
  /** Human session vs P1.10 machine token. */
  kind: "user" | "machine";
  /** Machine-token scopes (P1.10); absent/null for users and unrestricted tokens. */
  serviceScope?: string | null;
  clusterScope?: string | null;
}

function bearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (h && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return null;
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null; // malformed cookie value — treat as absent, don't 500 the auth hot-path
      }
    }
  }
  return null;
}

function clientIp(request: Request): string {
  // Behind a trusted proxy that OVERWRITES X-Forwarded-For. Per-username limiting (below) is
  // the real brute-force brake, since XFF is spoofable if the proxy appends instead of sets.
  const xff = request.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0]!.trim() : "unknown";
}

function isSecure(request: Request): boolean {
  return request.headers.get("x-forwarded-proto") === "https" || new URL(request.url).protocol === "https:";
}

function sessionCookie(token: string, secure: boolean): string {
  const attrs = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${TTL_SEC}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearedCookie(secure: boolean): string {
  const attrs = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Resolve the caller's principal from a machine token, a bearer JWT, or the session cookie. */
export async function authenticate(request: Request, deps: ApiDeps): Promise<Principal | null> {
  let token = bearer(request);
  let source: "bearer" | "cookie" = "bearer";
  // P1.10: a bearer with our token prefix is a machine token — hash it and look it up before JWT.
  if (token && looksLikeMachineToken(token)) {
    const row = deps.state.machineTokenByHash(hashMachineToken(token, deps.auth.jwtSecret));
    if (!row) return null;
    return {
      username: `machine:${row.name}`,
      role: row.role,
      csrf: null,
      source: "bearer",
      kind: "machine",
      serviceScope: row.service_scope,
      clusterScope: row.cluster_scope,
    };
  }
  if (!token) {
    token = cookieValue(request, COOKIE_NAME);
    source = "cookie";
  }
  if (!token) return null;
  const claims = await verifyJwt(token, deps.auth.jwtSecret, { nowMs: deps.clock.now() });
  if (!claims) return null;
  return {
    username: claims.sub,
    role: claims.role,
    csrf: typeof claims.csrf === "string" ? claims.csrf : null,
    source,
    kind: "user",
  };
}

const LoginBody = z.object({ username: z.string().min(1), password: z.string().min(1) });
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(MIN_PASSWORD_LEN),
});

export const authRoutes = (deps: ApiDeps) => {
  // Per-key token buckets (key = ip:<ip> or user:<username>); login trips on either.
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const overLimit = (key: string): boolean => {
    const now = deps.clock.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return bucket.count > LOGIN_LIMIT;
  };

  return new Elysia()
    .post(
      "/login",
      async ({ body, status, set, request }) => {
        if (overLimit(`ip:${clientIp(request)}`)) return status(429, { error: "too many attempts" });
        const parsed = LoginBody.safeParse(body ?? {});
        if (!parsed.success) return status(401, { error: "invalid credentials" });
        if (overLimit(`user:${parsed.data.username}`)) return status(429, { error: "too many attempts" });

        const user = deps.state.getUser(parsed.data.username);
        let ok = false;
        if (user) ok = await verifyPassword(parsed.data.password, user.password_hash);
        else await verifyPassword(parsed.data.password, DUMMY_PASSWORD_HASH); // equalize timing
        if (!user || !ok) return status(401, { error: "invalid credentials" });

        const csrf = randomBytes(18).toString("hex");
        const token = await signJwt({ sub: user.username, role: user.role, csrf }, deps.auth.jwtSecret, {
          ttlSec: TTL_SEC,
          nowMs: deps.clock.now(),
        });
        set.headers["set-cookie"] = sessionCookie(token, isSecure(request));
        log.info("auth.login", { username: user.username });
        return { username: user.username, role: user.role, mustChangePassword: user.must_change_password === 1 };
      },
      { detail: { summary: "Log in (sets the session cookie)", tags: ["auth"] } },
    )
    .get(
      "/me",
      async ({ request, status }) => {
        const principal = await authenticate(request, deps);
        if (!principal) return status(401, { error: "unauthorized" });
        const user = deps.state.getUser(principal.username);
        return {
          username: principal.username,
          role: principal.role,
          mustChangePassword: user?.must_change_password === 1,
          csrfToken: principal.csrf,
        };
      },
      { detail: { summary: "Current principal", tags: ["auth"] } },
    )
    .post(
      "/change-password",
      async ({ body, status, request }) => {
        const principal = await authenticate(request, deps);
        if (!principal) return status(401, { error: "unauthorized" });
        const parsed = ChangePasswordBody.safeParse(body ?? {});
        if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
        const user = deps.state.getUser(principal.username);
        if (!user) return status(401, { error: "unauthorized" });
        if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
          return status(401, { error: "current password is incorrect" });
        }
        deps.state.setUserPassword(user.username, await hashPassword(parsed.data.newPassword), false);
        log.info("auth.password_changed", { username: user.username });
        return { ok: true };
      },
      { detail: { summary: "Change the current user's password (clears must-change)", tags: ["auth"] } },
    )
    .post(
      "/logout",
      ({ set, request }) => {
        set.headers["set-cookie"] = clearedCookie(isSecure(request));
        return { ok: true };
      },
      { detail: { summary: "Clear the session cookie", tags: ["auth"] } },
    );
};
