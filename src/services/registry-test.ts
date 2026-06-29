import { presetById, type RegistryPresetId } from "./registry-presets.ts";

export interface RegistryTestInput {
  presetId: RegistryPresetId;
  registry?: string;
  region?: string;
  username: string;
  password: string;
}

export interface RegistryTestResult {
  ok: boolean;
  host?: string;
  reason?: string;
}

export interface RegistryTestFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type RegistryTestFetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<RegistryTestFetchResponse>;

const DEFAULT_TIMEOUT_MS = 8000;

function resolveHost(input: RegistryTestInput): string | { error: string } {
  const preset = presetById(input.presetId);
  if (!preset) return { error: `unknown preset '${input.presetId}'` };
  // Docker Hub's image path uses `docker.io/...` but its v2 endpoint lives at index.docker.io. We
  // hit the v2 host directly so the Bearer challenge resolves on the first request.
  let host = input.presetId === "docker-hub" ? "index.docker.io" : preset.host;
  if (host.includes("{registry}")) {
    if (!input.registry) return { error: `${preset.label} requires a registry name` };
    host = host.replaceAll("{registry}", input.registry);
  }
  if (host.includes("{region}")) {
    if (!input.region) return { error: `${preset.label} requires a region` };
    host = host.replaceAll("{region}", input.region);
  }
  return host;
}

interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

function parseBearerChallenge(header: string): BearerChallenge | null {
  if (!/^Bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  const re = /(realm|service|scope)="([^"]+)"/g;
  for (const m of header.matchAll(re)) params[m[1]!] = m[2]!;
  if (!params.realm) return null;
  return { realm: params.realm, service: params.service, scope: params.scope };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`request timed out after ${ms}ms`)), ms);
    promise
      .then((value) => {
        clearTimeout(id);
        resolve(value);
      })
      .catch((err: Error) => {
        clearTimeout(id);
        reject(err);
      });
  });
}

export async function testRegistryConnection(
  input: RegistryTestInput,
  fetcher: RegistryTestFetcher,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RegistryTestResult> {
  const host = resolveHost(input);
  if (typeof host !== "string") return { ok: false, reason: host.error };

  const basic = "Basic " + Buffer.from(`${input.username}:${input.password}`, "utf-8").toString("base64");

  // Step 1: GET /v2/ — the OCI Distribution v2 discovery endpoint. 200 = anonymous OK / already
  // authenticated; 401 with Www-Authenticate is the standard challenge.
  try {
    const probeUrl = `https://${host}/v2/`;
    const probe = await withTimeout(
      fetcher(probeUrl, { method: "GET", headers: { authorization: basic } }),
      timeoutMs,
    );
    if (probe.ok || probe.status === 200) {
      return { ok: true, host, reason: probe.status === 200 ? "registry accepts these credentials (or allows anonymous v2 access)" : "ok" };
    }
    if (probe.status !== 401) {
      const body = await probe.text().catch(() => "");
      return { ok: false, host, reason: `unexpected HTTP ${probe.status} from /v2/${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const challenge = parseBearerChallenge(probe.headers.get("www-authenticate") ?? "");
    if (!challenge) {
      // Some registries return Basic challenge instead of Bearer. If our basic auth already failed
      // the probe (status 401), the creds are wrong.
      return { ok: false, host, reason: "credentials rejected by /v2/ (Basic challenge)" };
    }
    // Step 2: follow the Bearer challenge — GET realm with the basic auth header. A successful token
    // exchange returns a JSON body with { token } or { access_token }.
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
    if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);
    const tokenRes = await withTimeout(
      fetcher(tokenUrl.toString(), { method: "GET", headers: { authorization: basic } }),
      timeoutMs,
    );
    if (tokenRes.ok || tokenRes.status === 200) {
      const body = (await tokenRes.json().catch(() => ({}))) as { token?: string; access_token?: string };
      if (body.token || body.access_token) return { ok: true, host };
      return { ok: false, host, reason: "token endpoint returned 200 but no token field" };
    }
    const text = await tokenRes.text().catch(() => "");
    return { ok: false, host, reason: `token endpoint returned ${tokenRes.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
  } catch (e) {
    return { ok: false, host, reason: (e as Error).message };
  }
}
