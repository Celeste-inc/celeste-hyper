import { timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  sub: string;
  role: string;
  [key: string]: unknown;
}

export interface JwtClaims extends JwtPayload {
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();
const b64urlJson = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/** Sign an HS256 JWT. `nowMs` is injectable for deterministic tests. */
export async function signJwt(
  payload: JwtPayload,
  secret: string,
  opts: { ttlSec: number; nowMs?: number },
): Promise<string> {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const claims: JwtClaims = { ...payload, iat: nowSec, exp: nowSec + opts.ttlSec };
  const data = `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson(claims)}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${Buffer.from(sig).toString("base64url")}`;
}

/** Verify an HS256 JWT's signature and expiry. Returns the claims, or null on any failure. */
export async function verifyJwt(token: string, secret: string, opts: { nowMs?: number } = {}): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  // Pin the algorithm: reject anything that isn't an HS256 JWT (defense against alg confusion).
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { alg?: string; typ?: string };
  } catch {
    return null;
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") return null;

  const data = `${parts[0]}.${parts[1]}`;

  let expected: Buffer;
  try {
    const key = await hmacKey(secret);
    expected = Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  } catch {
    return null;
  }
  const given = Buffer.from(parts[2]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JwtClaims;
  } catch {
    return null;
  }
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp < nowSec) return null;
  return claims;
}
