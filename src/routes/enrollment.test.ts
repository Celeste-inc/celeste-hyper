import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildApp } from "./_app.ts";
import { makeFakeDeps, TEST_JWT_SECRET } from "./test-fakes.ts";
import { call, pollAudit } from "./test-helpers.ts";
import { fakeClock } from "../lib/clock.ts";
import { signJwt } from "../lib/jwt.ts";

const GOOD_KUBECONFIG = [
  "apiVersion: v1",
  "kind: Config",
  "clusters:",
  "  - name: worker",
  "    cluster:",
  "      server: https://10.0.0.5:6443",
  "      certificate-authority-data: TEST_CA_DATA==",
  "users:",
  "  - { name: worker, user: { token: a-static-bearer-token } }",
  "contexts:",
  "  - { name: worker, context: { cluster: worker, user: worker } }",
  "current-context: worker",
  "",
].join("\n");

const asUser = (token: string) => ({ auth: false as const, headers: { authorization: `Bearer ${token}` } });
const noAuth = { auth: false as const };

async function mint(app: { handle(r: Request): Promise<Response> }, body: object = {}, opts: Parameters<typeof call>[4] = {}) {
  return call(app, "POST", "/api/enrollment-tokens", { name: "lab-edge", clusterId: "edge-1", ...body }, opts);
}

describe("enrollment tokens (admin management)", () => {
  it("mint returns the cleartext + a paste-ready join command once; list never leaks the hash/token", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const created = await mint(app, { clusterName: "Edge 1" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^che_/);
    expect(created.body.joinCommand).toContain(created.body.token);
    expect(created.body.joinCommand).toContain("MASTER_URL=");
    expect(created.body.enrollmentToken).not.toHaveProperty("hash_sha256");

    const list = await call(app, "GET", "/api/enrollment-tokens");
    expect(list.status).toBe(200);
    const row = list.body.items.find((t: { clusterId: string }) => t.clusterId === "edge-1");
    expect(row.status).toBe("active");
    expect(row).not.toHaveProperty("hash_sha256");
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
  });

  it("shell-quotes the paste-ready join command and ignores invalid forwarded hosts", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const created = await mint(app, { clusterId: "edge-shell" }, {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "master:8080;touch /tmp/pwn",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.joinCommand).toContain("sudo env MASTER_URL='http://localhost' ENROLL_TOKEN='che_");
    expect(created.body.joinCommand).not.toContain(";touch");
    const parsed = Bun.spawnSync(["bash", "-n", "-c", created.body.joinCommand]);
    expect(parsed.exitCode).toBe(0);
  });

  it("mint refuses a clusterId that is already registered", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    deps.clusters.create({ id: "edge-1", name: "x", kubeconfigPath: "/k", defaultNamespace: "default", runtime: "k3s", enabled: true } as never);
    expect((await mint(app)).status).toBe(400);
  });

  it("token management is admin-only", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const operator = await signJwt({ sub: "op", role: "operator" }, TEST_JWT_SECRET, { ttlSec: 3600 });
    expect((await call(app, "GET", "/api/enrollment-tokens", undefined, asUser(operator))).status).toBe(403);
    expect((await call(app, "POST", "/api/enrollment-tokens", { name: "x", clusterId: "y" }, asUser(operator))).status).toBe(403);
  });

  it("revoke makes a still-unused token unusable", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const created = await mint(app);
    const id = created.body.enrollmentToken.id;
    expect((await call(app, "DELETE", `/api/enrollment-tokens/${id}`)).status).toBe(200);
    const enroll = await call(app, "POST", "/api/enroll", { token: created.body.token, kubeconfig: GOOD_KUBECONFIG }, noAuth);
    expect(enroll.status).toBe(401);
  });
});

describe("POST /api/enroll (carve-out — token-authenticated)", () => {
  it("registers the worker as a cluster, writes a 0600 kubeconfig, and is single-use", async () => {
    const clustersDir = mkdtempSync(join(tmpdir(), "enroll-kc-"));
    const deps = makeFakeDeps({ clustersDir });
    const app = buildApp(deps);
    const token = (await mint(app, { clusterName: "Edge 1", runtime: "k3s", imageLoad: "remote-pull" })).body.token;

    const enroll = await call(app, "POST", "/api/enroll", { token, kubeconfig: GOOD_KUBECONFIG, nodeName: "edge-1" }, noAuth);
    expect(enroll.status).toBe(201);
    expect(enroll.body.cluster.id).toBe("edge-1");
    expect(enroll.body.cluster.origin).toBe("enrolled");
    expect(enroll.body.cluster.imageLoad).toBe("remote-pull");

    const kcPath = join(clustersDir, "edge-1.kubeconfig");
    expect(existsSync(kcPath)).toBe(true);
    expect(statSync(kcPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(kcPath, "utf8")).toContain("server: https://10.0.0.5:6443");

    const clusters = await call(app, "GET", "/api/clusters");
    expect(clusters.body.items.find((c: { id: string }) => c.id === "edge-1").origin).toBe("enrolled");

    // single-use: a replay of the same token fails
    const replay = await call(app, "POST", "/api/enroll", { token, kubeconfig: GOOD_KUBECONFIG }, noAuth);
    expect(replay.status).toBe(401);
  });

  it("rejects a bad token, a dangerous kubeconfig, and an expired token", async () => {
    const clock = fakeClock(0);
    const deps = makeFakeDeps({ clock });
    const app = buildApp(deps);
    expect((await call(app, "POST", "/api/enroll", { token: "che_nope", kubeconfig: GOOD_KUBECONFIG }, noAuth)).status).toBe(401);

    const token = (await mint(app, { expiresInMinutes: 30 })).body.token;
    // exec-plugin kubeconfig is rejected before the token is consumed
    const evil = GOOD_KUBECONFIG + "      exec:\n        command: /bin/evil\n";
    expect((await call(app, "POST", "/api/enroll", { token, kubeconfig: evil }, noAuth)).status).toBe(400);
    // ...so the token still works with a clean kubeconfig — until it expires
    clock.advance(31 * 60_000);
    expect((await call(app, "POST", "/api/enroll", { token, kubeconfig: GOOD_KUBECONFIG }, noAuth)).status).toBe(401);
  });

  it("audits a successful enrollment without logging the kubeconfig", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    const token = (await mint(app)).body.token;
    await call(app, "POST", "/api/enroll", { token, kubeconfig: GOOD_KUBECONFIG }, noAuth);
    const audit = await pollAudit(app, (items) => items.some((e) => e.action === "cluster.enroll" && e.result === "ok"));
    const row = audit.body.items.find((e: { action: string }) => e.action === "cluster.enroll");
    expect(row.resource_id).toBe("edge-1");
    expect(JSON.stringify(audit.body)).not.toContain("a-static-bearer-token");
  });

  it("rate-limits repeated token guesses even when X-Forwarded-For rotates", async () => {
    const deps = makeFakeDeps();
    const app = buildApp(deps);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await call(app, "POST", "/api/enroll", { token: "che_replayed_guess", kubeconfig: GOOD_KUBECONFIG }, {
        auth: false,
        headers: { "x-forwarded-for": `198.51.100.${i}` },
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
