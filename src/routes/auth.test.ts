import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, type CallResult } from "./test-helpers.ts";
import { ensureDefaultAdmin } from "../lib/auth-config.ts";
import { hashPassword } from "../lib/password.ts";
import type { Role } from "../lib/state.ts";

async function seedUser(
  deps: ReturnType<typeof makeFakeDeps>,
  password = "correct-horse-battery",
  over: { username?: string; role?: Role; mustChange?: boolean } = {},
): Promise<void> {
  const hash = await hashPassword(password);
  deps.state.createUser(over.username ?? "alice", hash, over.role ?? "admin", over.mustChange ?? false);
}

function cookieToken(res: CallResult): string | null {
  const m = (res.headers.get("set-cookie") ?? "").match(/hyper_session=([^;]+)/);
  return m ? m[1]! : null;
}

describe("default admin (ensureDefaultAdmin)", () => {
  it("logs in with admin/admin and is flagged mustChangePassword; no token leaked into the body", async () => {
    const deps = makeFakeDeps();
    await ensureDefaultAdmin(deps.state);
    const r = await call(buildApp(deps), "POST", "/api/login", { username: "admin", password: "admin" }, { auth: false });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe("admin");
    expect(r.body.role).toBe("admin");
    expect(r.body.mustChangePassword).toBe(true);
    expect(r.body.token).toBeUndefined();
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hyper_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("login", () => {
  it("rejects bad credentials with 401", async () => {
    const d = makeFakeDeps();
    await seedUser(d, "right-password");
    expect((await call(buildApp(d), "POST", "/api/login", { username: "alice", password: "wrong" }, { auth: false })).status).toBe(401);
  });

  it("rejects an unknown user with 401", async () => {
    expect((await call(buildApp(makeFakeDeps()), "POST", "/api/login", { username: "ghost", password: "x" }, { auth: false })).status).toBe(401);
  });

  it("rate-limits per IP", async () => {
    const d = makeFakeDeps();
    await seedUser(d, "pw");
    const app = buildApp(d);
    const ip = { "x-forwarded-for": "10.0.0.1" };
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await call(app, "POST", "/api/login", { username: `u${i}`, password: "x" }, { auth: false, headers: ip })).status;
    }
    expect(last).toBe(429);
  });

  it("rate-limits per username even across rotating IPs (XFF-spoof resistant)", async () => {
    const d = makeFakeDeps();
    await seedUser(d, "pw");
    const app = buildApp(d);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await call(app, "POST", "/api/login", { username: "alice", password: "wrong" }, { auth: false, headers: { "x-forwarded-for": `9.9.9.${i}` } })).status;
    }
    expect(last).toBe(429);
  });
});

describe("me / change-password / logout / guard", () => {
  it("me requires auth and returns the principal + mustChangePassword", async () => {
    const d = makeFakeDeps();
    await seedUser(d, "pw", { mustChange: true });
    const app = buildApp(d);
    expect((await call(app, "GET", "/api/me", undefined, { auth: false })).status).toBe(401);
    const login = await call(app, "POST", "/api/login", { username: "alice", password: "pw" }, { auth: false });
    const me = await call(app, "GET", "/api/me", undefined, { auth: false, headers: { authorization: `Bearer ${cookieToken(login)}` } });
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("alice");
    expect(me.body.mustChangePassword).toBe(true);
  });

  it("change-password verifies current, enforces length, clears must-change, and the new password works", async () => {
    const d = makeFakeDeps();
    await seedUser(d, "oldpassword", { mustChange: true });
    const app = buildApp(d);
    const login = await call(app, "POST", "/api/login", { username: "alice", password: "oldpassword" }, { auth: false });
    const headers = { authorization: `Bearer ${cookieToken(login)}` };

    expect((await call(app, "POST", "/api/change-password", { currentPassword: "nope", newPassword: "longenough1" }, { auth: false, headers })).status).toBe(401);
    expect((await call(app, "POST", "/api/change-password", { currentPassword: "oldpassword", newPassword: "short" }, { auth: false, headers })).status).toBe(422);

    const ok = await call(app, "POST", "/api/change-password", { currentPassword: "oldpassword", newPassword: "a-new-strong-pw" }, { auth: false, headers });
    expect(ok.status).toBe(200);

    const me = await call(app, "GET", "/api/me", undefined, { auth: false, headers });
    expect(me.body.mustChangePassword).toBe(false);
    expect((await call(app, "POST", "/api/login", { username: "alice", password: "a-new-strong-pw" }, { auth: false })).status).toBe(200);
  });

  it("change-password requires auth", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/change-password", { currentPassword: "x", newPassword: "longenough1" }, { auth: false });
    expect(r.status).toBe(401);
  });

  it("logout clears the session cookie", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/logout");
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("guards protected /api routes: 401 without a token, 200 with one; health public", async () => {
    const app = buildApp(makeFakeDeps());
    expect((await call(app, "GET", "/api/clusters", undefined, { auth: false })).status).toBe(401);
    expect((await call(app, "GET", "/api/clusters")).status).toBe(200);
    expect((await call(app, "GET", "/api/health", undefined, { auth: false })).status).toBe(200);
  });
});
