import { describe, it, expect } from "bun:test";
import { signJwt, verifyJwt } from "./jwt.ts";

const SECRET = "x".repeat(32);
const NOW = 1_000_000_000_000; // fixed ms

describe("jwt", () => {
  it("sign/verify round-trips the claims", async () => {
    const token = await signJwt({ sub: "alice", role: "admin" }, SECRET, { ttlSec: 3600, nowMs: NOW });
    const claims = await verifyJwt(token, SECRET, { nowMs: NOW });
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("alice");
    expect(claims!.role).toBe("admin");
    expect(claims!.exp).toBe(Math.floor(NOW / 1000) + 3600);
  });

  it("rejects a tampered payload", async () => {
    const token = await signJwt({ sub: "alice", role: "viewer" }, SECRET, { ttlSec: 3600, nowMs: NOW });
    const [h, , s] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ sub: "alice", role: "admin", iat: 1, exp: 9_999_999_999 }),
    ).toString("base64url");
    const forged = `${h}.${forgedBody}.${s}`;
    expect(await verifyJwt(forged, SECRET, { nowMs: NOW })).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signJwt({ sub: "alice", role: "admin" }, SECRET, { ttlSec: 60, nowMs: NOW });
    expect(await verifyJwt(token, SECRET, { nowMs: NOW + 61_000 })).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signJwt({ sub: "alice", role: "admin" }, SECRET, { ttlSec: 60, nowMs: NOW });
    expect(await verifyJwt(token, "y".repeat(32), { nowMs: NOW })).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifyJwt("not.a.jwt", SECRET, { nowMs: NOW })).toBeNull();
    expect(await verifyJwt("only-one-part", SECRET, { nowMs: NOW })).toBeNull();
  });

  it("rejects a token whose header alg is not HS256 (alg-confusion defense)", async () => {
    const enc = new TextEncoder();
    const header = Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "a", role: "admin", iat: 1, exp: 9_999_999_999 })).toString("base64url");
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, enc.encode(data))).toString("base64url");
    expect(await verifyJwt(`${data}.${sig}`, SECRET, { nowMs: NOW })).toBeNull();
  });
});
