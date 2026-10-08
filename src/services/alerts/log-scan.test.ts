import { describe, expect, it } from "bun:test";
import { normalizeForFingerprint, normalizeTs, redact, scanLogLines } from "./log-scan.ts";

const ts = (s: number) => `2026-10-07T20:00:${String(s).padStart(2, "0")}.123456789Z`;

describe("scanLogLines", () => {
  it("detects structlog/JSON errors and keeps the useful fields", () => {
    const line = `${ts(1)} {"event":"extraction.job.failed","level":"error","timestamp":"x","job_id":42,"exception":"Traceback...\\nValueError: boom"}`;
    const { findings, lastTimestamp } = scanLogLines([line, `${ts(2)} {"event":"ok","level":"info"}`], null);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toBe("extraction.job.failed");
    expect(findings[0]!.detail).toContain("ValueError: boom");
    expect(lastTimestamp).toBe(ts(2));
  });

  it("detects winston lines with ANSI colours, python logging, quarkus and nginx", () => {
    const lines = [
      `${ts(1)} 2026-10-07 17:39:00 [\u001b[31merror\u001b[39m]: transcription upload failed {"id":"49"}`,
      `${ts(2)} 2026-10-07 17:39:00 [\u001b[32minfo\u001b[39m]: Contact sync job finished`,
      `${ts(3)} ERROR:root:database unreachable`,
      `${ts(4)} 2026-10-07 17:39:00,123 ERROR [org.keycloak.services] (executor-thread-1) KC-SERVICES0010: Failed`,
      `${ts(5)} 2026/10/07 17:39:00 [error] 29#29: *1 connect() failed (111: Connection refused)`,
      `${ts(6)} INFO:     127.0.0.1:0 - "GET /health HTTP/1.1" 200 OK`,
    ];
    const { findings } = scanLogLines(lines, null);
    expect(findings.map((f) => f.message.slice(0, 30))).toEqual([
      "transcription upload failed",
      "ERROR:root:database unreachabl",
      "2026-10-07 17:39:00,123 ERROR ",
      "2026/10/07 17:39:00 [error] 29",
    ]);
  });

  it("promotes winston errors tagged with severity critical", () => {
    const line = `${ts(1)} 2026-10-07 18:00:00 [\u001b[31merror\u001b[39m]: Pipeline: TM de origem esta atras {"check":"tm_source_regressed","severity":"critical"}`;
    const [finding] = scanLogLines([line], null).findings;
    expect(finding!.level).toBe("critical");
    expect(finding!.message).toBe("Pipeline: TM de origem esta atras");
    expect(finding!.detail).toBe("check: tm_source_regressed\nseverity: critical");
  });

  it("groups a python traceback into one finding", () => {
    const lines = [
      `${ts(1)} Traceback (most recent call last):`,
      `${ts(1)}   File "/app/x.py", line 3, in <module>`,
      `${ts(1)}     raise RuntimeError("db down")`,
      `${ts(1)} RuntimeError: db down`,
      `${ts(2)} next request ok`,
    ];
    const { findings } = scanLogLines(lines, null);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toBe("Traceback: RuntimeError: db down");
    expect(findings[0]!.detail.split("\n")).toHaveLength(4);
  });

  it("skips lines at or before the cursor even with different fraction lengths", () => {
    const lines = ["2026-10-07T20:00:01Z {\"level\":\"error\",\"event\":\"old\"}", "2026-10-07T20:00:01.5Z {\"level\":\"error\",\"event\":\"new\"}"];
    const { findings } = scanLogLines(lines, "2026-10-07T20:00:01.000000000Z");
    expect(findings.map((f) => f.message)).toEqual(["new"]);
  });
});

describe("redact", () => {
  it("masks credentials, tokens, DSNs and webhooks", () => {
    const text = [
      "password=hunter2 token: abc.def",
      "postgresql://sollo:s3cr3t@db:5432/x",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      '{"api_key":"sk-proj-ABCDEFGHIJKLMNOP"}',
      "https://hooks.slack.com/services/T0/B0/xyz",
      "jwt=eyJhbGciOi.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      "Cookie: session=abc123; theme=dark",
      "aws AKIAIOSFODNN7EXAMPLE",
    ].join("\n");
    const out = redact(text);
    for (const secret of ["hunter2", "abc.def", "s3cr3t", "eyJhbGciOiJIUzI1NiJ9", "ABCDEFGHIJKLMNOP", "xyz", "c2lnbmF0dXJl", "abc123", "IOSFODNN7EXAMPLE"]) expect(out).not.toContain(secret);
  });
});

describe("normalization", () => {
  it("collapses ids and numbers so recurring errors share a fingerprint", () => {
    expect(normalizeForFingerprint("job 42 failed for 3f2a9c1e-1111-2222-3333-444455556666 at 2026-10-07T20:00:01Z"))
      .toBe(normalizeForFingerprint("job 7 failed for 9a9a9a9a-1111-2222-3333-444455556666 at 2026-10-08T01:02:03Z"));
  });

  it("pads timestamps to nanoseconds", () => {
    expect(normalizeTs("2026-10-07T20:00:01Z")).toBe("2026-10-07T20:00:01.000000000Z");
    expect(normalizeTs("2026-10-07T20:00:01.5Z")).toBe("2026-10-07T20:00:01.500000000Z");
  });
});
