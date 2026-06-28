import { describe, it, expect } from "bun:test";
import { State } from "./state.ts";
import { resolveAuthConfig, AuthConfigError, ensureDefaultAdmin, DEFAULT_ADMIN_USERNAME } from "./auth-config.ts";
import { verifyPassword } from "./password.ts";

const long = "x".repeat(32);

describe("resolveAuthConfig", () => {
  it("rejects a too-short HYPER_JWT_SECRET", () => {
    const s = new State(":memory:");
    expect(() => resolveAuthConfig(s, { HYPER_JWT_SECRET: "short" })).toThrow(AuthConfigError);
    s.close();
  });

  it("uses the env secret verbatim and does not persist it", () => {
    const s = new State(":memory:");
    const cfg = resolveAuthConfig(s, { HYPER_JWT_SECRET: long });
    expect(cfg.jwtSecret).toBe(long);
    expect(s.getMeta("jwt_secret")).toBeNull();
    s.close();
  });

  it("generates and persists a secret when none is configured, and reuses it", () => {
    const s = new State(":memory:");
    const a = resolveAuthConfig(s, {});
    expect(a.jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(s.getMeta("jwt_secret")).toBe(a.jwtSecret);
    expect(resolveAuthConfig(s, {}).jwtSecret).toBe(a.jwtSecret);
    s.close();
  });

  it("prefers the env secret over a persisted one", () => {
    const s = new State(":memory:");
    s.setMeta("jwt_secret", "persisted-" + "y".repeat(32));
    expect(resolveAuthConfig(s, { HYPER_JWT_SECRET: long }).jwtSecret).toBe(long);
    s.close();
  });
});

describe("ensureDefaultAdmin", () => {
  it("creates a temporary admin/admin with must_change_password on an empty DB", async () => {
    const s = new State(":memory:");
    const created = await ensureDefaultAdmin(s);
    expect(created).toBe(true);
    const user = s.getUser(DEFAULT_ADMIN_USERNAME);
    expect(user).not.toBeNull();
    expect(user!.role).toBe("admin");
    expect(user!.must_change_password).toBe(1);
    expect(await verifyPassword("admin", user!.password_hash)).toBe(true);
    expect(user!.password_hash.startsWith("$argon2id$")).toBe(true);
    s.close();
  });

  it("does nothing when a user already exists", async () => {
    const s = new State(":memory:");
    s.createUser("someone", "$argon2id$hash", "admin", false);
    expect(await ensureDefaultAdmin(s)).toBe(false);
    expect(s.countUsers()).toBe(1);
    s.close();
  });
});
