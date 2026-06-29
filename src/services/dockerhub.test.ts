import { describe, it, expect } from "bun:test";
import { parseDockerHubSearch, searchDockerHub, DOCKER_HUB_SEARCH_URL, type DockerHubFetcher } from "./dockerhub.ts";

const sample = {
  count: 2,
  results: [
    {
      repo_name: "library/nginx",
      short_description: "Official build of Nginx.",
      star_count: 20000,
      pull_count: 1_000_000_000,
      is_official: true,
      is_automated: false,
    },
    {
      repo_name: "bitnami/nginx",
      short_description: "Bitnami's nginx",
      star_count: 200,
      pull_count: 10_000_000,
      is_official: false,
      is_automated: true,
    },
  ],
};

describe("parseDockerHubSearch", () => {
  it("normalises Docker Hub's search response into a flat image entry list", () => {
    const items = parseDockerHubSearch(sample);
    expect(items).toEqual([
      { name: "library/nginx", description: "Official build of Nginx.", stars: 20000, pulls: 1_000_000_000, official: true },
      { name: "bitnami/nginx", description: "Bitnami's nginx", stars: 200, pulls: 10_000_000, official: false },
    ]);
  });

  it("returns an empty list when Docker Hub returns no results", () => {
    expect(parseDockerHubSearch({ count: 0, results: [] })).toEqual([]);
    expect(parseDockerHubSearch({})).toEqual([]);
  });

  it("tolerates missing fields without throwing", () => {
    const items = parseDockerHubSearch({ results: [{ repo_name: "foo/bar" }] });
    expect(items[0]).toMatchObject({ name: "foo/bar", description: "", stars: 0, pulls: 0, official: false });
  });
});

describe("searchDockerHub", () => {
  it("calls the Docker Hub v2 search endpoint with the URL-encoded query + page_size cap", async () => {
    let url = "";
    const fetcher: DockerHubFetcher = async (target) => {
      url = target;
      return { ok: true, status: 200, json: async () => sample };
    };
    const items = await searchDockerHub("nginx web server", { fetcher, pageSize: 25 });
    expect(url.startsWith(DOCKER_HUB_SEARCH_URL)).toBe(true);
    expect(url).toContain("query=nginx+web+server");
    expect(url).toContain("page_size=25");
    expect(items).toHaveLength(2);
  });

  it("rejects with a meaningful error when Docker Hub returns non-2xx", async () => {
    const fetcher: DockerHubFetcher = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await expect(searchDockerHub("nginx", { fetcher })).rejects.toThrow(/503/);
  });

  it("rejects when q is empty (cheap guard against an unconstrained list endpoint hit)", async () => {
    const fetcher: DockerHubFetcher = async () => {
      throw new Error("should not be called");
    };
    await expect(searchDockerHub("", { fetcher })).rejects.toThrow(/query/i);
    await expect(searchDockerHub("   ", { fetcher })).rejects.toThrow(/query/i);
  });

  it("caps page_size to a sensible bound (no hammering the upstream)", async () => {
    let url = "";
    const fetcher: DockerHubFetcher = async (target) => {
      url = target;
      return { ok: true, status: 200, json: async () => sample };
    };
    await searchDockerHub("x", { fetcher, pageSize: 9999 });
    // Anything ≤ 100 is fine; 9999 must be clamped.
    const m = url.match(/page_size=(\d+)/)!;
    expect(Number(m[1])).toBeLessThanOrEqual(100);
  });
});
