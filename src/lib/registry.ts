import { log } from "./logger.ts";

export interface ImageRefParts {
  host: string;
  repository: string;
  source: "docker-hub" | "custom";
}

const DOCKER_HUB_HOST = "registry-1.docker.io";

export function parseImageRef(ref: string): ImageRefParts {
  const trimmed = ref.trim().replace(/^docker\.io\//, "").replace(/:.+$|@.+$/, "");
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) {
    return { host: DOCKER_HUB_HOST, repository: `library/${trimmed}`, source: "docker-hub" };
  }
  const head = trimmed.slice(0, slashIdx);
  if (head.includes(".") || head.includes(":") || head === "localhost") {
    return { host: head, repository: trimmed.slice(slashIdx + 1), source: "custom" };
  }
  return { host: DOCKER_HUB_HOST, repository: trimmed, source: "docker-hub" };
}

interface ChallengeParams {
  realm: string;
  service?: string;
  scope?: string;
}

function parseChallenge(header: string): ChallengeParams | null {
  if (!/^Bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    if (m[1]) params[m[1]] = m[2] ?? "";
  }
  if (!params.realm) return null;
  return { realm: params.realm, service: params.service, scope: params.scope };
}

async function fetchBearer(params: ChallengeParams): Promise<string | null> {
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set("service", params.service);
  if (params.scope) url.searchParams.set("scope", params.scope);
  const resp = await fetch(url.toString());
  if (!resp.ok) return null;
  const json = (await resp.json()) as { token?: string; access_token?: string };
  return json.token ?? json.access_token ?? null;
}

export interface ListTagsResult {
  tags: string[];
  rateLimited?: boolean;
  authRequired?: boolean;
  error?: string;
}

const TAG_CACHE = new Map<string, { at: number; result: ListTagsResult }>();
const CACHE_TTL_MS = 60_000;

export async function listRegistryTags(imageRef: string): Promise<ListTagsResult> {
  if (!imageRef) return { tags: [], error: "imageRef is empty" };
  const cached = TAG_CACHE.get(imageRef);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const { host, repository } = parseImageRef(imageRef);
  const url = `https://${host}/v2/${repository}/tags/list?n=200`;
  log.debug("registry.list_tags", { host, repository });

  const headers: Record<string, string> = { Accept: "application/json" };
  let resp = await fetch(url, { headers });
  if (resp.status === 401) {
    const challenge = parseChallenge(resp.headers.get("www-authenticate") ?? "");
    if (!challenge) {
      const r: ListTagsResult = { tags: [], authRequired: true, error: "registry challenge missing" };
      TAG_CACHE.set(imageRef, { at: Date.now(), result: r });
      return r;
    }
    const token = await fetchBearer(challenge);
    if (!token) {
      const r: ListTagsResult = { tags: [], authRequired: true, error: "anonymous token denied" };
      TAG_CACHE.set(imageRef, { at: Date.now(), result: r });
      return r;
    }
    resp = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${token}` } });
  }

  if (resp.status === 429) {
    return { tags: [], rateLimited: true };
  }
  if (!resp.ok) {
    return { tags: [], error: `registry status ${resp.status}` };
  }
  const body = (await resp.json()) as { tags?: string[] | null };
  const tags = (body.tags ?? []).filter((t): t is string => typeof t === "string");
  const result: ListTagsResult = { tags };
  TAG_CACHE.set(imageRef, { at: Date.now(), result });
  return result;
}

export function sortTagsDesc(tags: string[]): string[] {
  return [...tags].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
}
