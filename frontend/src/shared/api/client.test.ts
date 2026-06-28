import { describe, it, expect, vi, afterEach } from "vitest";
import { http, setCsrfToken } from "./client";

afterEach(() => setCsrfToken(null));

function jsonResponse() {
  return new Response("{}", { headers: { "content-type": "application/json" } });
}

describe("http client CSRF wiring", () => {
  it("attaches X-CSRF-Token on mutations once set, but not on reads", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse());
    setCsrfToken("tok-123");

    await http.createCluster({ id: "c" });
    const mutInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(mutInit.headers).get("x-csrf-token")).toBe("tok-123");

    await http.clusters();
    const getInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(new Headers(getInit?.headers).get("x-csrf-token")).toBeNull();
  });

  it("omits the header when no token is set", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse());
    await http.createCluster({ id: "c" });
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-csrf-token")).toBeNull();
  });
});
