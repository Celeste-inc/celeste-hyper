import { describe, it, expect } from "bun:test";
import { resolveLogFormat, formatLine } from "./logger.ts";

describe("resolveLogFormat", () => {
  it("defaults to json", () => {
    expect(resolveLogFormat([], {})).toBe("json");
  });

  it("honours LOG_FORMAT=pretty", () => {
    expect(resolveLogFormat([], { LOG_FORMAT: "pretty" })).toBe("pretty");
  });

  it("honours --log-format=pretty (and --log-format pretty)", () => {
    expect(resolveLogFormat(["bun", "src/index.ts", "--log-format=pretty"], {})).toBe("pretty");
    expect(resolveLogFormat(["bun", "src/index.ts", "--log-format", "pretty"], {})).toBe("pretty");
  });

  it("lets the CLI flag win over the env", () => {
    expect(resolveLogFormat(["--log-format=json"], { LOG_FORMAT: "pretty" })).toBe("json");
  });

  it("falls back to json for an unknown value", () => {
    expect(resolveLogFormat(["--log-format=xml"], {})).toBe("json");
    expect(resolveLogFormat([], { LOG_FORMAT: "yaml" })).toBe("json");
  });
});

describe("formatLine", () => {
  const rec = { ts: "2026-06-28T14:38:07.442Z", level: "info" as const, event: "listening", url: "http://0.0.0.0:8080" };

  it("json round-trips the record verbatim", () => {
    expect(JSON.parse(formatLine("json", rec))).toEqual(rec);
  });

  it("pretty renders level, event and key=value fields", () => {
    const out = formatLine("pretty", rec);
    expect(out).toContain("INFO");
    expect(out).toContain("listening");
    expect(out).toContain("url=http://0.0.0.0:8080");
    expect(out).toContain("14:38:07.442");
    expect(out).not.toContain("\n");
  });

  it("pretty keeps one record on one line even when the event or a key carries a newline", () => {
    const out = formatLine("pretty", { ts: "2026-06-28T14:38:07.442Z", level: "info" as const, event: "a\nb", "k\ny": 1 });
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain('"a\\nb"');
    expect(out).toContain('"k\\ny"=1');
  });

  it("pretty quotes values containing whitespace and serialises objects", () => {
    const out = formatLine("pretty", { ts: "2026-06-28T14:38:07.442Z", level: "warn" as const, event: "shutdown.worker_not_drained", note: "running job exceeded grace" });
    expect(out).toContain('note="running job exceeded grace"');
    const obj = formatLine("pretty", { ts: "2026-06-28T14:38:07.442Z", level: "error" as const, event: "x", err: { code: 1 } });
    expect(obj).toContain('err={"code":1}');
  });
});
