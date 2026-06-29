import { describe, it, expect } from "bun:test";
import { State } from "../lib/state.ts";
import { RegistrySourceStore, type RegistrySourceInput } from "./registry-sources.ts";

function makeStore() {
  const state = new State(":memory:");
  return { state, store: new RegistrySourceStore(state) };
}

const baseInput: RegistrySourceInput = {
  id: "ghcr-main",
  name: "GHCR (acme org)",
  presetId: "ghcr",
  username: "octocat",
  password: "ghp_xxx",
};

describe("RegistrySourceStore", () => {
  it("starts empty", () => {
    const { store } = makeStore();
    expect(store.list()).toEqual([]);
  });

  it("upserts a registry source and lists its summary (without the secret)", () => {
    const { store } = makeStore();
    store.upsert(baseInput);
    const summaries = store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: "ghcr-main",
      name: "GHCR (acme org)",
      presetId: "ghcr",
      username: "octocat",
      secretConfigured: true,
    });
    expect((summaries[0] as unknown as { password?: string }).password).toBeUndefined();
  });

  it("get(id) returns the full credentials including the password (for internal use)", () => {
    const { store } = makeStore();
    store.upsert(baseInput);
    const full = store.get("ghcr-main");
    expect(full!.password).toBe("ghp_xxx");
  });

  it("get(id) returns null for unknown id", () => {
    const { store } = makeStore();
    expect(store.get("nope")).toBeNull();
  });

  it("rejects an id that doesn't match the slug regex", () => {
    const { store } = makeStore();
    expect(() => store.upsert({ ...baseInput, id: "Bad ID!" })).toThrow(/id/i);
  });

  it("overwrites the same id without duplicating the row", () => {
    const { store } = makeStore();
    store.upsert(baseInput);
    store.upsert({ ...baseInput, name: "GHCR renamed" });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.name).toBe("GHCR renamed");
  });

  it("preserves the previous password when secretAccessKey is omitted on an update (PATCH-style)", () => {
    const { store } = makeStore();
    store.upsert(baseInput);
    store.upsert({ id: "ghcr-main", name: "renamed", presetId: "ghcr", username: "octocat" });
    expect(store.get("ghcr-main")!.password).toBe("ghp_xxx");
  });

  it("requires a password on FIRST create (no prior password to preserve)", () => {
    const { store } = makeStore();
    expect(() =>
      store.upsert({ id: "ghcr-main", name: "x", presetId: "ghcr", username: "u" }),
    ).toThrow(/password/i);
  });

  it("delete(id) removes the source when nothing references it", () => {
    const { store } = makeStore();
    store.upsert(baseInput);
    expect(store.delete("ghcr-main", () => false)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("delete(id) refuses when the in-use callback returns true", () => {
    const { store } = makeStore();
    store.upsert(baseInput);
    expect(() => store.delete("ghcr-main", () => true)).toThrow(/in use|used/i);
  });

  it("survives a round-trip via the underlying State", () => {
    const { state, store } = makeStore();
    store.upsert(baseInput);
    const reopened = new RegistrySourceStore(state);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get("ghcr-main")!.password).toBe("ghp_xxx");
  });

  it("returns sources sorted by id for stable UI ordering", () => {
    const { store } = makeStore();
    store.upsert({ ...baseInput, id: "z-source" });
    store.upsert({ ...baseInput, id: "a-source" });
    store.upsert({ ...baseInput, id: "m-source" });
    expect(store.list().map((s) => s.id)).toEqual(["a-source", "m-source", "z-source"]);
  });
});
