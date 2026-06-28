import { describe, it, expect } from "bun:test";
import { parseRows, serializeRows, rowErrors } from "./env-files.ts";

describe("parseRows", () => {
  it("parses unquoted, single-quoted, and double-quoted values", () => {
    const rows = parseRows(`A=plain\nB='literal $x'\nC="quoted"`);
    expect(rows).toEqual([
      { key: "A", value: "plain" },
      { key: "B", value: "literal $x" },
      { key: "C", value: "quoted" },
    ]);
  });

  it("handles a double-quoted multi-line value (real newlines in the file)", () => {
    expect(parseRows('KEY="line1\nline2"')).toEqual([{ key: "KEY", value: "line1\nline2" }]);
  });

  it("handles \\n escapes and escaped quotes", () => {
    expect(parseRows('A="x\\ny"')).toEqual([{ key: "A", value: "x\ny" }]);
    expect(parseRows('B="a\\"b"')).toEqual([{ key: "B", value: 'a"b' }]);
  });

  it("attaches a preceding comment block as the row description", () => {
    expect(parseRows("# the database url\nDB_URL=postgres://x")).toEqual([
      { key: "DB_URL", value: "postgres://x", description: "the database url" },
    ]);
  });

  it("rejects duplicate keys with a specific error", () => {
    expect(() => parseRows("A=1\nA=2")).toThrow("duplicate key: A");
  });

  it("ignores blank lines and stray non-kv lines", () => {
    expect(parseRows("\n\nA=1\nnonsense\n")).toEqual([{ key: "A", value: "1" }]);
  });
});

describe("serializeRows", () => {
  it("round-trips quoted multi-line values", () => {
    const rows = [{ key: "K", value: "line1\nline2" }];
    const { content } = serializeRows(rows);
    expect(content).toBe('K="line1\\nline2"\n');
    expect(parseRows(content)).toEqual(rows);
  });

  it("preserves order and emits descriptions as comments", () => {
    const { content } = serializeRows([
      { key: "B", value: "2" },
      { key: "A", value: "1", description: "first" },
    ]);
    expect(content).toBe("B=2\n# first\nA=1\n");
  });

  it("strips disallowed control chars and reports the affected keys", () => {
    const { content, stripped } = serializeRows([{ key: "X", value: "a\bbc" }]); // \b = backspace (0x08)
    expect(content).toBe("X=abc\n");
    expect(stripped).toEqual(["X"]);
  });

  it("leaves an empty value bare (KEY=)", () => {
    expect(serializeRows([{ key: "K", value: "" }]).content).toBe("K=\n");
  });
});

describe("rowErrors", () => {
  it("flags empty, invalid, and duplicate keys; allows empty values", () => {
    expect(rowErrors([{ key: "OK", value: "" }])).toEqual([]);
    expect(rowErrors([{ key: "", value: "x" }])).toContain("empty key");
    expect(rowErrors([{ key: "bad-key", value: "x" }])[0]).toContain("invalid key");
    expect(rowErrors([{ key: "A", value: "1" }, { key: "A", value: "2" }])).toContain("duplicate key: A");
  });
});
