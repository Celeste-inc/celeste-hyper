import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// A fresh default fetch per test: returns an empty, well-shaped JSON payload. Tests override
// per-case with `vi.spyOn(globalThis, "fetch")...` or by replacing `globalThis.fetch`.
function defaultFetch(): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ items: [], unmanaged: [] }), {
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

// Reset shared globals between tests so per-case overrides / accumulated mock.calls never leak.
beforeEach(() => {
  globalThis.fetch = defaultFetch();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Also available at import time (before the first beforeEach).
globalThis.fetch = defaultFetch();

// jsdom has no EventSource; provide a no-op that emits via dispatchEvent.
class MockEventSource extends EventTarget {
  url: string;
  readyState = 0;
  constructor(url: string) {
    super();
    this.url = url;
  }
  close() {
    this.readyState = 2;
  }
}
if (!("EventSource" in globalThis)) {
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
}

// jsdom provides localStorage; polyfill only if it is somehow missing.
if (!("localStorage" in globalThis)) {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}
