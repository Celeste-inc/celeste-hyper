import { describe, it, expect } from "bun:test";
import {
  expandTargets,
  fingerprintDistribution,
  classifyProbe,
  scanNetwork,
  readBounded,
  type VersionProbe,
  type ProbeResult,
} from "./network-scan.ts";

function streamOf(totalBytes: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        let sent = 0;
        while (sent < totalBytes) {
          const chunk = Math.min(8192, totalBytes - sent);
          c.enqueue(new Uint8Array(chunk).fill(65)); // 'A'
          sent += chunk;
        }
        c.close();
      },
    }),
  );
}

const versionBody = (gitVersion: string) =>
  JSON.stringify({ major: "1", minor: "31", gitVersion, gitCommit: "abc", platform: "linux/amd64" });

describe("expandTargets", () => {
  it("expands a single IP and a small CIDR", () => {
    const r = expandTargets(["10.0.0.5", "192.168.1.0/30"]);
    expect("ips" in r && r.ips).toEqual(["10.0.0.5", "192.168.1.0", "192.168.1.1", "192.168.1.2", "192.168.1.3"]);
  });

  it("respects the 1024-IP cap", () => {
    expect(expandTargets(["10.0.0.0/22"])).toEqual({ ips: expect.any(Array) }); // /22 == 1024, allowed
    expect((expandTargets(["10.0.0.0/22"]) as { ips: string[] }).ips.length).toBe(1024);
    const over = expandTargets(["10.0.0.0/21"]); // 2048
    expect("error" in over && over.error).toContain("1024-IP cap");
  });

  it("rejects a bad target with a precise message", () => {
    expect(expandTargets(["not-an-ip"])).toEqual({ error: expect.stringContaining("invalid target 'not-an-ip'") });
    expect(expandTargets(["10.0.0.300"])).toEqual({ error: expect.stringContaining("invalid target") });
    expect(expandTargets(["10.0.0.0/40"])).toEqual({ error: expect.stringContaining("invalid CIDR") });
  });

  it("de-duplicates overlapping targets", () => {
    const r = expandTargets(["10.0.0.1", "10.0.0.0/31"]) as { ips: string[] };
    expect(r.ips).toEqual(["10.0.0.1", "10.0.0.0"]);
  });
});

describe("fingerprintDistribution", () => {
  it("detects k3s", () => expect(fingerprintDistribution("v1.31.13+k3s1")).toBe("k3s"));
  it("detects rke2", () => expect(fingerprintDistribution("v1.30.4+rke2r1")).toBe("rke2"));
  it("treats a vanilla kubeadm version as k8s", () => expect(fingerprintDistribution("v1.31.0")).toBe("k8s"));
});

describe("classifyProbe", () => {
  it("classifies a k3s apiserver from its /version", () => {
    const c = classifyProbe("10.0.0.1", 6443, { reachable: true, ms: 12, body: versionBody("v1.31.13+k3s1") });
    expect(c).toMatchObject({ reachable: true, distribution: "k3s", serverVersion: "v1.31.13+k3s1", authMethods: ["bearer-token", "client-cert"] });
  });

  it("a reachable port with no /version shape → reachable:true, distribution:unknown", () => {
    expect(classifyProbe("10.0.0.1", 8443, { reachable: true, ms: 5, body: "<html>nginx</html>" })).toMatchObject({
      reachable: true,
      distribution: "unknown",
      serverVersion: null,
    });
    // reachable, JSON but wrong shape
    expect(classifyProbe("10.0.0.1", 8443, { reachable: true, ms: 5, body: '{"hello":"world"}' }).distribution).toBe("unknown");
  });

  it("an unreachable port → reachable:false", () => {
    expect(classifyProbe("10.0.0.9", 6443, { reachable: false, ms: 1500 })).toMatchObject({ reachable: false, distribution: "unknown" });
  });
});

describe("scanNetwork", () => {
  const probeFor = (hits: Record<string, string>): VersionProbe => async (ip, port): Promise<ProbeResult> => {
    const key = `${ip}:${port}`;
    if (key in hits) return { reachable: true, ms: 10, body: hits[key] };
    return { reachable: false, ms: 1500 };
  };

  it("returns only reachable candidates and counts every tuple", async () => {
    const probe = probeFor({ "10.0.0.1:6443": versionBody("v1.31.13+k3s1") });
    const r = await scanNetwork(["10.0.0.0/30"], [6443, 8443], 1500, probe);
    expect("candidates" in r).toBe(true);
    if (!("candidates" in r)) return;
    expect(r.ipsScanned).toBe(4);
    expect(r.tuplesScanned).toBe(8);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ ip: "10.0.0.1", port: 6443, distribution: "k3s" });
  });

  it("surfaces an expansion error instead of scanning", async () => {
    const r = await scanNetwork(["10.0.0.0/8"], [6443], 1500, probeFor({}));
    expect(r).toEqual({ error: expect.stringContaining("1024-IP cap") });
  });

  it("survives a throwing probe (treats it as unreachable)", async () => {
    const throwing: VersionProbe = async () => {
      throw new Error("socket exploded");
    };
    const r = await scanNetwork(["10.0.0.1"], [6443], 1500, throwing);
    expect("candidates" in r && r.candidates).toEqual([]);
  });

  it("readBounded caps a flood and passes small bodies through intact", async () => {
    expect((await readBounded(streamOf(200_000), 64 * 1024)).length).toBe(64 * 1024); // truncated to the cap
    expect(await readBounded(streamOf(11), 64 * 1024)).toBe("AAAAAAAAAAA"); // small body intact
  });

  it("stops at the wall-clock deadline and reports a partial scan", async () => {
    // More tuples than the 64-wide concurrency, each taking real time, with a tiny deadline → the
    // workers stop pulling new tuples once the budget is blown.
    const slow: VersionProbe = async () => {
      await new Promise((r) => setTimeout(r, 8));
      return { reachable: false, ms: 8 };
    };
    const r = await scanNetwork(["10.0.0.0/24"], [6443], 1500, slow, 1); // 256 tuples, 1 ms budget
    expect("candidates" in r).toBe(true);
    if (!("candidates" in r)) return;
    expect(r.timedOut).toBe(true);
    expect(r.tuplesScanned).toBeLessThan(256);
  });
});
