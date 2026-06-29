import { describe, it, expect } from "bun:test";
import { stringify } from "./yaml.ts";

describe("yaml.stringify", () => {
  it("renders a simple object as block YAML", () => {
    const y = stringify({ kind: "Service", metadata: { name: "web" } });
    expect(y).toContain("kind: Service");
    expect(y).toContain("name: web");
  });

  it("quotes numeric-looking strings to preserve their string type", () => {
    const y = stringify({ tag: "1.27", port: 80 });
    expect(y).toContain('tag: "1.27"'); // string, must stay quoted
    expect(y).toContain("port: 80"); // number, no quotes
  });

  it("renders arrays as YAML list items", () => {
    const y = stringify({ items: [{ name: "a" }, { name: "b" }] });
    expect(y).toContain("- name: a");
    expect(y).toContain("- name: b");
  });

  it("emits {} / [] for empty objects and arrays inline", () => {
    expect(stringify({ a: {}, b: [] })).toMatch(/a: \{\}/);
    expect(stringify({ a: {}, b: [] })).toMatch(/b: \[\]/);
  });
});
