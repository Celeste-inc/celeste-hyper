import { describe, it, expect } from "bun:test";
import { buildApp } from "../routes/_app.ts";
import { makeFakeDeps } from "../routes/test-fakes.ts";
import { call, seedCluster, seedRegistryService } from "../routes/test-helpers.ts";

// Public contract snapshots (CC.6). These pin the *shape* (field names, nesting, value types — not the
// values, so ids/timestamps don't make them flaky) of every JSON payload in the [Protected contracts]
// table of docs/implementation-plan.md. A field rename or removal changes the shape and fails the
// matching assertion below; when that happens, decide whether it is additive (just re-baseline the
// shape here) or breaking (a rename/removal) — and if breaking, the PR title must say "breaking change".
// (The SSE `…/logs` event contract and the SQLite-table contract are pinned by the logs tests and
//  bootstrap.test.ts respectively; this file covers the HTTP JSON payloads.)

/** Structural fingerprint of a value: objects → sorted key→shape, arrays → [elementShape], leaves → typeof/"null". */
function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : ["?empty"];
  if (v === null) return "null";
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = shapeOf((v as Record<string, unknown>)[k]);
    return out;
  }
  return typeof v;
}

function seededApp() {
  const deps = makeFakeDeps();
  seedCluster(deps);
  seedRegistryService(deps);
  return buildApp(deps);
}

describe("public contract snapshots (CC.6)", () => {
  it("GET /api/services", async () => {
    const r = await call(seededApp(), "GET", "/api/services");
    expect(r.status).toBe(200);
    expect(shapeOf(r.body)).toEqual({
      infrastructure: ["?empty"],
      items: [
        {
          activeDeployment: "null",
          cluster: "null",
          clusterId: "string",
          currentTag: "null",
          deployedAt: "null",
          enabled: "boolean",
          env: {
            config: { exists: "boolean", keys: ["?empty"], path: "string" },
            secret: { exists: "boolean", keys: ["?empty"], path: "string" },
          },
          imageRef: "string",
          name: "string",
          namespace: "string",
          newVersion: "null",
          sourceType: "string",
          workloadKind: "string",
        },
      ],
      lastTickAt: "null",
      unmanaged: ["?empty"],
    });
  });

  it("GET /api/services/:name", async () => {
    const r = await call(seededApp(), "GET", "/api/services/hello");
    expect(r.status).toBe(200);
    expect(shapeOf(r.body)).toEqual({
      currentTag: "null",
      deployedAt: "null",
      service: {
        clusterId: "string",
        enabled: "boolean",
        imageRef: "string",
        name: "string",
        namespace: "string",
        sourceType: "string",
        workloadKind: "string",
      },
    });
  });

  it("POST /api/services/:name/deploy → 202", async () => {
    const r = await call(seededApp(), "POST", "/api/services/hello/deploy", { tag: "v1.10.4" });
    expect(r.status).toBe(202);
    expect(shapeOf(r.body)).toEqual({ accepted: "boolean", deploymentId: "number" });
  });

  it("GET /api/deployments/:id", async () => {
    const app = seededApp();
    const created = await call(app, "POST", "/api/services/hello/deploy", { tag: "v1.10.4" });
    const r = await call(app, "GET", `/api/deployments/${created.body.deploymentId}`);
    expect(r.status).toBe(200);
    expect(shapeOf(r.body)).toEqual({
      deployment: {
        action: "string",
        finished_at: "null",
        health_gate_result: "null",
        id: "number",
        message: "null",
        service: "string",
        started_at: "string",
        status: "string",
        tag: "string",
      },
    });
  });

  it("GET /api/clusters", async () => {
    const r = await call(seededApp(), "GET", "/api/clusters");
    expect(r.status).toBe(200);
    expect(shapeOf(r.body)).toEqual({
      items: [
        {
          capabilities: {},
          capabilitiesCheckedAt: "null",
          defaultNamespace: "string",
          enabled: "boolean",
          health: { checkedAt: "string", clusterId: "string", message: "string", ok: "boolean", reachable: "boolean" },
          id: "string",
          kubeconfigPath: "string",
          kubectlVersion: "null",
          name: "string",
          runtime: "string",
          serverVersion: "null",
          serviceCount: "number",
          versionSkew: { client: "null", ok: "boolean", reason: "null", server: "null" },
        },
      ],
    });
  });

  it("GET /api/services/:name/networking", async () => {
    const r = await call(seededApp(), "GET", "/api/services/hello/networking");
    expect(r.status).toBe(200);
    expect(shapeOf(r.body)).toEqual({ hint: "string", service: "null" });
  });
});
