import { describe, it, expect } from "bun:test";
import { testRegistryConnection, type RegistryTestFetcher } from "./registry-test.ts";

interface FakeResponse {
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function fetcherFromMap(map: Record<string, FakeResponse>): RegistryTestFetcher {
  return async (url, _init) => {
    const res = map[url];
    if (!res) throw new Error(`no fake response for ${url}`);
    return {
      ok: res.ok,
      status: res.status,
      headers: {
        get: (k: string) => res.headers?.[k.toLowerCase()] ?? null,
      },
      json: async () => res.body ?? {},
      text: async () => (typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? {})),
    };
  };
}

describe("testRegistryConnection — Docker Hub", () => {
  it("returns ok=true when the Bearer challenge succeeds with the supplied creds", async () => {
    const fetcher = fetcherFromMap({
      "https://index.docker.io/v2/": {
        ok: false,
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' },
      },
      "https://auth.docker.io/token?service=registry.docker.io": {
        ok: true,
        status: 200,
        body: { token: "ey…", access_token: "ey…" },
      },
    });
    const r = await testRegistryConnection({
      presetId: "docker-hub",
      username: "vinicius",
      password: "dckr_pat_xxx",
    }, fetcher);
    expect(r.ok).toBe(true);
    expect(r.host).toBe("index.docker.io");
  });

  it("returns ok=false with a precise reason when the token endpoint rejects the credentials", async () => {
    const fetcher = fetcherFromMap({
      "https://index.docker.io/v2/": {
        ok: false,
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' },
      },
      "https://auth.docker.io/token?service=registry.docker.io": {
        ok: false,
        status: 401,
        body: { errors: [{ code: "UNAUTHORIZED", message: "incorrect username or password" }] },
      },
    });
    const r = await testRegistryConnection({
      presetId: "docker-hub",
      username: "vinicius",
      password: "wrong",
    }, fetcher);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/UNAUTHORIZED|password|401/i);
  });

  it("returns ok=true when the v2 endpoint allows anonymous access (rare but supported)", async () => {
    const fetcher = fetcherFromMap({
      "https://index.docker.io/v2/": { ok: true, status: 200 },
    });
    const r = await testRegistryConnection({
      presetId: "docker-hub",
      username: "anon",
      password: "anything",
    }, fetcher);
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/anonymous|public/i);
  });
});

describe("testRegistryConnection — GHCR", () => {
  it("follows the ghcr.io Bearer challenge", async () => {
    const fetcher = fetcherFromMap({
      "https://ghcr.io/v2/": {
        ok: false,
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
      },
      "https://ghcr.io/token?service=ghcr.io": {
        ok: true,
        status: 200,
        body: { token: "abc" },
      },
    });
    const r = await testRegistryConnection({ presetId: "ghcr", username: "octocat", password: "ghp_xxx" }, fetcher);
    expect(r.ok).toBe(true);
    expect(r.host).toBe("ghcr.io");
  });
});

describe("testRegistryConnection — Azure ACR", () => {
  it("hits the parameterised <registry>.azurecr.io/oauth2/token endpoint", async () => {
    const fetcher = fetcherFromMap({
      "https://celeste.azurecr.io/v2/": {
        ok: false,
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://celeste.azurecr.io/oauth2/token",service="celeste.azurecr.io"' },
      },
      "https://celeste.azurecr.io/oauth2/token?service=celeste.azurecr.io": {
        ok: true,
        status: 200,
        body: { access_token: "eyJ…" },
      },
    });
    const r = await testRegistryConnection({
      presetId: "acr",
      registry: "celeste",
      username: "00000000-0000-0000-0000-000000000000",
      password: "sp-secret",
    }, fetcher);
    expect(r.ok).toBe(true);
    expect(r.host).toBe("celeste.azurecr.io");
  });

  it("422 reason when the ACR registry name is missing", async () => {
    const r = await testRegistryConnection({
      presetId: "acr",
      username: "x",
      password: "y",
    }, fetcherFromMap({}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/registry/i);
  });
});

describe("testRegistryConnection — AWS ECR", () => {
  it("hits the parameterised <acc>.dkr.ecr.<region>.amazonaws.com endpoint", async () => {
    const fetcher = fetcherFromMap({
      "https://123456789012.dkr.ecr.us-east-1.amazonaws.com/v2/": {
        ok: true,
        status: 200, // ECR's /v2/ returns 200 with a valid Authorization header from get-login-password
      },
    });
    const r = await testRegistryConnection({
      presetId: "ecr",
      registry: "123456789012",
      region: "us-east-1",
      username: "AWS",
      password: "ecr-token",
    }, fetcher);
    expect(r.ok).toBe(true);
  });

  it("422 reason when the ECR region is missing", async () => {
    const r = await testRegistryConnection({
      presetId: "ecr",
      registry: "123456789012",
      username: "AWS",
      password: "x",
    }, fetcherFromMap({}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/region/i);
  });
});

describe("testRegistryConnection — failure modes", () => {
  it("surfaces network errors verbatim", async () => {
    const fetcher: RegistryTestFetcher = async () => {
      throw new Error("ENOTFOUND no-such-host");
    };
    const r = await testRegistryConnection({
      presetId: "ghcr",
      username: "x",
      password: "y",
    }, fetcher);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ENOTFOUND");
  });

  it("times out gracefully when the fetcher hangs", async () => {
    const fetcher: RegistryTestFetcher = () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("timeout")), 5);
      });
    const r = await testRegistryConnection({
      presetId: "ghcr",
      username: "x",
      password: "y",
    }, fetcher);
    expect(r.ok).toBe(false);
  });
});
