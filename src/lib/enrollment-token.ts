import { createHmac, randomBytes } from "node:crypto";

const PREFIX = "che_"; // celeste-hyper-enroll; one-shot token a worker presents to /api/enroll

/** A fresh cleartext enrollment token: `che_` + 32 random bytes (base64url). Shown to the admin once. */
export function generateEnrollmentToken(): string {
  return PREFIX + randomBytes(32).toString("base64url");
}

const KEY_DOMAIN = "celeste-hyper/enrollment-token-key/v1";

/**
 * Keyed hash of an enrollment token (HMAC-SHA256). Only this digest is stored, so a DB leak alone can
 * neither recover nor forge a token. The HMAC key is derived from the server auth secret with a fixed
 * domain string distinct from the machine-token and JWT-signing domains, so the three are
 * cryptographically separated even though they seed from the same configured secret.
 */
export function hashEnrollmentToken(token: string, secret: string): string {
  const key = createHmac("sha256", secret).update(KEY_DOMAIN).digest();
  return createHmac("sha256", key).update(token).digest("hex");
}

/** Cheap prefix check so the auth path can tell an enrollment token from a machine token / JWT. */
export function looksLikeEnrollmentToken(token: string): boolean {
  return token.startsWith(PREFIX);
}
