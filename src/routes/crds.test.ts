import { describe, it, expect } from "bun:test";
import { buildApp } from "./_app.ts";
import { makeFakeDeps } from "./test-fakes.ts";
import { call, seedCluster } from "./test-helpers.ts";
import { signJwt } from "../lib/jwt.ts";
import { TEST_JWT_SECRET } from "./test-fakes.ts";

const crdJson = JSON.stringify({
  items: [{ metadata: { name: "certificates.cert-manager.io" }, spec: { group: "cert-manager.io", names: { kind: "Certificate", plural: "certificates" }, scope: "Namespaced", versions: [{ name: "v1", served: true, storage: true }] } }],
});
const crListJson = JSON.stringify({ items: [{ metadata: { name: "web-tls", namespace: "prod", creationTimestamp: "2026-06-28T00:00:00Z" } }] });

const KNOWN_CRD = "certificates.cert-manager.io";

/** A kubectl fake dispatching on the verb/object. The `get crd -o name -- <resource>` existence
 *  check returns 0 only for the known CRD (so a non-CRD resource is rejected). */
function k8sCrd() {
  return {
    kubectl: async (args: string[]) => {
      if (args.includes("crd")) {
        if (args.includes("name")) return args[args.length - 1] === KNOWN_CRD ? { code: 0, stdout: `customresourcedefinition.apiextensions.k8s.io/${KNOWN_CRD}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "NotFound" };
        return { code: 0, stdout: crdJson, stderr: "" };
      }
      if (args.includes("-o") && args.includes("yaml")) return { code: 0, stdout: "apiVersion: cert-manager.io/v1\nkind: Certificate\n", stderr: "" };
      return { code: 0, stdout: crListJson, stderr: "" };
    },
  };
}

const operator = () => signJwt({ sub: "op", role: "operator" }, TEST_JWT_SECRET, { ttlSec: 3600 });
const viewer = () => signJwt({ sub: "v", role: "viewer" }, TEST_JWT_SECRET, { ttlSec: 3600 });
const asTok = async (mk: () => Promise<string>) => ({ auth: false as const, headers: { authorization: `Bearer ${await mk()}` } });

describe("CRD browser routes", () => {
  it("lists CRDs (parsed)", async () => {
    const deps = makeFakeDeps({ k8s: k8sCrd() });
    seedCluster(deps);
    const r = await call(buildApp(deps), "GET", "/api/clusters/primary/crds");
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ name: "certificates.cert-manager.io", kind: "Certificate", plural: "certificates", namespaced: true });
  });

  it("lists objects of a kind and returns one as YAML", async () => {
    const deps = makeFakeDeps({ k8s: k8sCrd() });
    seedCluster(deps);
    const app = buildApp(deps);
    const objs = await call(app, "GET", "/api/clusters/primary/crds/certificates.cert-manager.io/objects?namespace=prod");
    expect(objs.status).toBe(200);
    expect(objs.body.items[0]).toMatchObject({ name: "web-tls", namespace: "prod" });
    const yaml = await call(app, "GET", "/api/clusters/primary/crds/certificates.cert-manager.io/objects/web-tls/yaml?namespace=prod");
    expect(yaml.status).toBe(200);
    expect(yaml.body.yaml).toContain("kind: Certificate");
  });

  it("refuses a non-CRD resource (e.g. secrets.) so it can't read core resource data", async () => {
    const deps = makeFakeDeps({ k8s: k8sCrd() });
    seedCluster(deps);
    const app = buildApp(deps);
    // 'secrets.' passes the charset+dot check but is NOT a registered CRD → 404 (never reaches `get secrets.`)
    expect((await call(app, "GET", "/api/clusters/primary/crds/secrets./objects")).status).toBe(404);
    expect((await call(app, "GET", "/api/clusters/primary/crds/secrets./objects/db-creds/yaml")).status).toBe(404);
  });

  it("validates the resource and object name (400)", async () => {
    const deps = makeFakeDeps({ k8s: k8sCrd() });
    seedCluster(deps);
    const app = buildApp(deps);
    expect((await call(app, "GET", "/api/clusters/primary/crds/nogroup/objects")).status).toBe(400); // no dot
    expect((await call(app, "GET", "/api/clusters/primary/crds/x.io/objects/--all/yaml")).status).toBe(400); // bad name
  });

  it("is operator-gated: operator 200, viewer 403", async () => {
    const deps = makeFakeDeps({ k8s: k8sCrd() });
    seedCluster(deps);
    const app = buildApp(deps);
    expect((await call(app, "GET", "/api/clusters/primary/crds", undefined, await asTok(operator))).status).toBe(200);
    expect((await call(app, "GET", "/api/clusters/primary/crds", undefined, await asTok(viewer))).status).toBe(403);
  });

  it("502 when kubectl fails on the CRD list", async () => {
    const deps = makeFakeDeps({ k8s: { kubectl: async () => ({ code: 1, stdout: "", stderr: "the server doesn't have a resource type" }) } });
    seedCluster(deps);
    expect((await call(buildApp(deps), "GET", "/api/clusters/primary/crds")).status).toBe(502);
  });
});
