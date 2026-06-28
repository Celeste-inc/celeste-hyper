import { randomBytes } from "node:crypto";
import type { State } from "./state.ts";
import { hashPassword } from "./password.ts";
import { log } from "./logger.ts";

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export interface AuthConfig {
  /** HS256 signing secret. */
  jwtSecret: string;
}

const MIN_SECRET_LEN = 32;

/** Username/password for the auto-created first admin (temporary; must be changed on first login). */
export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "admin";

/**
 * Resolve auth secrets at boot. `HYPER_JWT_SECRET` (if set) must be ≥32 chars or this throws
 * `AuthConfigError` (the boot layer turns that into a non-zero exit). Otherwise the secret
 * falls back to a value persisted in `meta`, else a fresh 32-byte random secret is generated
 * and persisted so sessions survive restarts.
 */
export function resolveAuthConfig(state: State, env: Record<string, string | undefined> = Bun.env): AuthConfig {
  const envSecret = env.HYPER_JWT_SECRET;
  if (envSecret !== undefined && envSecret.length < MIN_SECRET_LEN) {
    throw new AuthConfigError(`HYPER_JWT_SECRET must be at least ${MIN_SECRET_LEN} characters`);
  }

  let jwtSecret = envSecret ?? state.getMeta("jwt_secret") ?? "";
  if (!jwtSecret) {
    jwtSecret = randomBytes(32).toString("hex");
    state.setMeta("jwt_secret", jwtSecret);
  }

  return { jwtSecret };
}

/**
 * On first boot with no users, create the temporary default admin (`admin`/`admin`) with
 * `must_change_password` set, and warn loudly. Returns whether it created the admin.
 */
export async function ensureDefaultAdmin(state: State): Promise<boolean> {
  if (state.countUsers() > 0) return false;
  const hash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
  state.createUser(DEFAULT_ADMIN_USERNAME, hash, "admin", true);
  log.warn("auth.default_admin_created", {
    username: DEFAULT_ADMIN_USERNAME,
    warning: "temporary default credentials admin/admin created — log in and change the password immediately",
  });
  return true;
}
