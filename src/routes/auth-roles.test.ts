import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, TEST_JWT_SECRET } from "./test-fakes.ts";
import { call } from "./test-helpers.ts";
import { signJwt } from "../lib/jwt.ts";
import { hashPassword } from "../lib/password.ts";

async function bearerHeaders(role: string): Promise<Record<string, string>> {
  const token = await signJwt({ sub: `u-${role}`, role }, TEST_JWT_SECRET, { ttlSec: 3600 });
  return { authorization: `Bearer ${token}` };
}

const NEW_CLUSTER = { id: "c1", name: "Cluster One", kubeconfigPath: "/k" };

describe("role enforcement (bearer, CSRF-exempt)", () => {
  it("viewer can read but cannot create a cluster (403)", async () => {
    const app = buildApp(makeFakeDeps());
    const h = await bearerHeaders("viewer");
    expect((await call(app, "GET", "/api/clusters", undefined, { auth: false, headers: h })).status).toBe(200);
    const r = await call(app, "POST", "/api/clusters", NEW_CLUSTER, { auth: false, headers: h });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("forbidden");
  });

  it("operator can create a cluster", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/clusters", NEW_CLUSTER, {
      auth: false,
      headers: await bearerHeaders("operator"),
    });
    expect(r.status).toBe(201);
  });

  it("admin can mutate", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/clusters", NEW_CLUSTER, {
      auth: false,
      headers: await bearerHeaders("admin"),
    });
    expect(r.status).toBe(201);
  });
});

describe("CSRF (cookie auth)", () => {
  it("a cookie GET needs no CSRF and the cookie carries a csrf token", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const { cookie, csrf } = await cookieSession(app, deps);
    expect(typeof csrf).toBe("string");
    expect(csrf.length).toBeGreaterThan(0);
    expect((await call(app, "GET", "/api/clusters", undefined, { auth: false, headers: { cookie } })).status).toBe(200);
  });

  it("a cookie mutation without X-CSRF-Token is rejected (csrf_missing)", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const { cookie } = await cookieSession(app, deps);
    const r = await call(app, "POST", "/api/clusters", NEW_CLUSTER, { auth: false, headers: { cookie } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("csrf_missing");
  });

  it("a cookie mutation with the wrong X-CSRF-Token is rejected (csrf_invalid)", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const { cookie } = await cookieSession(app, deps);
    const r = await call(app, "POST", "/api/clusters", NEW_CLUSTER, { auth: false, headers: { cookie, "x-csrf-token": "wrong" } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("csrf_invalid");
  });

  it("a cookie mutation with the correct X-CSRF-Token succeeds", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const { cookie, csrf } = await cookieSession(app, deps);
    const r = await call(app, "POST", "/api/clusters", NEW_CLUSTER, { auth: false, headers: { cookie, "x-csrf-token": csrf } });
    expect(r.status).toBe(201);
  });

  it("a bearer mutation needs no CSRF", async () => {
    const r = await call(buildApp(makeFakeDeps()), "POST", "/api/clusters", NEW_CLUSTER, {
      auth: false,
      headers: await bearerHeaders("admin"),
    });
    expect(r.status).toBe(201);
  });

  it("rejects a CSRF token from a different session (cross-session isolation)", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const a = await cookieSession(app, deps);
    const b = await cookieSession(app, deps); // distinct login → distinct csrf
    const r = await call(app, "POST", "/api/clusters", NEW_CLUSTER, {
      auth: false,
      headers: { cookie: a.cookie, "x-csrf-token": b.csrf },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("csrf_invalid");
  });
});

// Lock in that the guard (auth + role + CSRF) fires on EVERY mutating sub-plugin, not just
// clusters — a future plugin mounted outside the guarded /api instance would fail these.
const GUARDED_MUTATIONS: Array<[string, string]> = [
  ["POST", "/api/services"],
  ["PATCH", "/api/services/foo"],
  ["DELETE", "/api/services/foo"],
  ["POST", "/api/services/foo/deploy"],
  ["PUT", "/api/services/foo/env/config"],
  ["POST", "/api/clusters"],
  ["PATCH", "/api/clusters/foo"],
  ["DELETE", "/api/clusters/foo"],
  ["POST", "/api/clusters/foo/check"],
];

describe("guard covers every mutating sub-plugin", () => {
  for (const [method, path] of GUARDED_MUTATIONS) {
    it(`${method} ${path}: 401 unauth, 403 viewer, 403 csrf_missing (cookie)`, async () => {
      const deps = makeFakeDeps();
      const app = buildApp(deps);
      expect((await call(app, method, path, {}, { auth: false })).status).toBe(401);
      expect((await call(app, method, path, {}, { auth: false, headers: await bearerHeaders("viewer") })).status).toBe(403);
      const { cookie } = await cookieSession(app, deps);
      const r = await call(app, method, path, {}, { auth: false, headers: { cookie } });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("csrf_missing");
    });
  }
});

async function cookieSession(app: ReturnType<typeof buildApp>, deps: ReturnType<typeof makeFakeDeps>) {
  const uname = `user${deps.state.countUsers()}`; // unique per call within a deps (PK is username)
  deps.state.createUser(uname, await hashPassword("pw-strong"), "admin", false);
  const login = await call(app, "POST", "/api/login", { username: uname, password: "pw-strong" }, { auth: false });
  const cookie = (login.headers.get("set-cookie") ?? "").match(/hyper_session=[^;]+/)?.[0] ?? "";
  const me = await call(app, "GET", "/api/me", undefined, { auth: false, headers: { cookie } });
  return { cookie, csrf: me.body.csrfToken as string };
}
