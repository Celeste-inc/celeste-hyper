import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call } from "./test-helpers.ts";
import type { VersionProbe } from "../services/network-scan.ts";
import { signJwt } from "../lib/jwt.ts";
import { TEST_JWT_SECRET } from "./test-fakes.ts";

const k3sBody = JSON.stringify({ major: "1", minor: "31", gitVersion: "v1.31.13+k3s1" });
const hitProbe = (key: string): VersionProbe => async (ip, port) =>
  `${ip}:${port}` === key ? { reachable: true, ms: 8, body: k3sBody } : { reachable: false, ms: 1500 };

async function operatorToken() {
  return signJwt({ sub: "op", role: "operator" }, TEST_JWT_SECRET, { ttlSec: 3600 });
}

describe("discovery routes", () => {
  it("a valid consented scan returns the discovered candidates", async () => {
    const deps = makeFakeDeps({ netProbe: hitProbe("10.0.0.2:6443") });
    const r = await call(buildApp(deps), "POST", "/api/discovery/scan", {
      targets: ["10.0.0.0/30"],
      ports: [6443],
      consent: "scan-acknowledged",
    });
    expect(r.status).toBe(200);
    expect(r.body.ipsScanned).toBe(4);
    expect(r.body.candidates).toHaveLength(1);
    expect(r.body.candidates[0]).toMatchObject({ ip: "10.0.0.2", port: 6443, distribution: "k3s" });
  });

  it("missing or wrong consent returns 400 and does not scan", async () => {
    const deps = makeFakeDeps({ netProbe: hitProbe("10.0.0.2:6443") });
    const app = buildApp(deps);
    const noConsent = await call(app, "POST", "/api/discovery/scan", { targets: ["10.0.0.0/30"] });
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.error).toBe("consent-required");
    const wrong = await call(app, "POST", "/api/discovery/scan", { targets: ["10.0.0.0/30"], consent: "yes" });
    expect(wrong.status).toBe(400);
  });

  it("a bad target returns 400 with a precise message", async () => {
    const deps = makeFakeDeps();
    const r = await call(buildApp(deps), "POST", "/api/discovery/scan", { targets: ["nope"], consent: "scan-acknowledged" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid-targets");
    expect(r.body.message).toContain("invalid target");
  });

  it("an over-cap CIDR returns 400", async () => {
    const deps = makeFakeDeps();
    const r = await call(buildApp(deps), "POST", "/api/discovery/scan", { targets: ["10.0.0.0/8"], consent: "scan-acknowledged" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("1024-IP cap");
  });

  it("is admin only — an operator gets 403, unauthenticated 401", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const opTok = await operatorToken();
    const op = await call(app, "POST", "/api/discovery/scan", { targets: ["10.0.0.1"], consent: "scan-acknowledged" }, {
      auth: false,
      headers: { authorization: `Bearer ${opTok}` },
    });
    expect(op.status).toBe(403);
    const anon = await call(app, "POST", "/api/discovery/scan", { targets: ["10.0.0.1"], consent: "scan-acknowledged" }, { auth: false });
    expect(anon.status).toBe(401);
  });

  it("rejects an empty targets list (422)", async () => {
    const deps = makeFakeDeps();
    const r = await call(buildApp(deps), "POST", "/api/discovery/scan", { targets: [], consent: "scan-acknowledged" });
    expect(r.status).toBe(422);
  });
});
