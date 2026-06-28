import { createHmac, randomBytes } from "node:crypto";

const PREFIX = "cht_"; // celeste-hyper-token; lets the auth path cheaply tell tokens from JWTs

/** A fresh cleartext machine token: `cht_` + 32 random bytes (base64url). Shown to the operator once. */
export function generateMachineToken(): string {
  return PREFIX + randomBytes(32).toString("base64url");
}

const KEY_DOMAIN = "celeste-hyper/machine-token-key/v1";

/**
 * Keyed hash of a token (HMAC-SHA256). Only this digest is stored, so a DB leak alone can neither
 * recover nor forge a token; auth hashes the presented token the same way and looks it up by the
 * digest. The HMAC key is *derived* from the server auth secret with a fixed domain string rather
 * than using the JWT signing secret directly, so the token-hash and session-signing keys are
 * cryptographically separated even though both seed from the same configured secret.
 */
export function hashMachineToken(token: string, secret: string): string {
  const key = createHmac("sha256", secret).update(KEY_DOMAIN).digest();
  return createHmac("sha256", key).update(token).digest("hex");
}

/** Cheap prefix check so the auth hot-path skips the token table for obvious JWTs. */
export function looksLikeMachineToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

/** An unguessable URL path segment that authorizes reaching a webhook row. */
export function generateSecretId(): string {
  return randomBytes(16).toString("hex");
}

/** The per-webhook HMAC secret the registry signs its payloads with. */
export function generateWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}
