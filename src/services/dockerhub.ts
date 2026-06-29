export const DOCKER_HUB_SEARCH_URL = "https://hub.docker.com/v2/search/repositories/";
const MAX_PAGE_SIZE = 100;

export interface DockerHubImage {
  name: string;
  description: string;
  stars: number;
  pulls: number;
  official: boolean;
}

export interface DockerHubFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DockerHubFetcher = (url: string) => Promise<DockerHubFetchResponse>;

interface RawSearchResponse {
  count?: number;
  results?: Array<{
    repo_name?: string;
    short_description?: string;
    star_count?: number;
    pull_count?: number;
    is_official?: boolean;
  }>;
}

export function parseDockerHubSearch(raw: unknown): DockerHubImage[] {
  const r = (raw ?? {}) as RawSearchResponse;
  if (!Array.isArray(r.results)) return [];
  return r.results.map((entry) => ({
    name: entry.repo_name ?? "",
    description: entry.short_description ?? "",
    stars: typeof entry.star_count === "number" ? entry.star_count : 0,
    pulls: typeof entry.pull_count === "number" ? entry.pull_count : 0,
    official: Boolean(entry.is_official),
  }));
}

export interface SearchOptions {
  fetcher?: DockerHubFetcher;
  pageSize?: number;
}

const defaultFetcher: DockerHubFetcher = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

export async function searchDockerHub(query: string, opts: SearchOptions = {}): Promise<DockerHubImage[]> {
  const q = query.trim();
  if (!q) throw new Error("query must not be empty");
  const pageSize = Math.min(opts.pageSize ?? 25, MAX_PAGE_SIZE);
  const url = `${DOCKER_HUB_SEARCH_URL}?query=${encodeURIComponent(q).replace(/%20/g, "+")}&page_size=${pageSize}`;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`Docker Hub search failed: HTTP ${res.status}`);
  const body = await res.json();
  return parseDockerHubSearch(body);
}
