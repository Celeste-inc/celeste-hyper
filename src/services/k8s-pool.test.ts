import { describe, it, expect } from "bun:test";
import { readyzProbeArgs, HEALTH_PROBE_TIMEOUT_SEC } from "./k8s-pool.ts";

describe("readyzProbeArgs", () => {
  it("includes a bounded --request-timeout so one hung cluster can't stall the poller tick", () => {
    const args = readyzProbeArgs();
    expect(args).toContain("--raw=/readyz");
    expect(args).toContain(`--request-timeout=${HEALTH_PROBE_TIMEOUT_SEC}s`);
    expect(args[0]).toBe("get");
  });

  it("honours an explicit timeout override", () => {
    expect(readyzProbeArgs(3)).toEqual(["get", "--raw=/readyz", "--request-timeout=3s"]);
  });
});
