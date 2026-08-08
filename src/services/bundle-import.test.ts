import { describe, it, expect } from "bun:test";
import { buildBundleImportJob, importJobName, runRemoteBundleImport, K3S_CONTAINERD_SOCKET, K3S_HOST_BINARY, type ImportK8s } from "./bundle-import.ts";

const OK = { code: 0, stdout: "", stderr: "" };
const noDelay = async () => {};

type NodeFixture = {
  name: string;
  ready?: boolean;
  unschedulable?: boolean;
  os?: string;
};

/** Fake K8s over the single `kubectl` seam. Routes by argv: get nodes / apply / get job / delete /
 *  logs. Enforces real apiserver semantics where they bit us before: applying a Job name that already
 *  exists with a different pod template is rejected ("field is immutable"). Every call also asserts it
 *  carries a `--request-timeout` bound (the HIGH-severity fix). */
function importK8s(
  opts: {
    applyCode?: number;
    succeedAfter?: number;
    fail?: boolean;
    failOn?: string;
    getCode?: number;
    jobLogs?: string;
    logsThrow?: boolean;
    nodes?: (string | NodeFixture)[];
    nodesError?: string;
    nodesGarbled?: boolean;
  } = {},
) {
  const calls = { apply: 0, get: 0, del: 0, logs: 0, nodes: 0, untimed: 0 };
  const applies: any[] = [];
  const live = new Map<string, string>(); // name -> serialized pod template (immutability check)
  const deleted: string[] = [];
  let gets = 0;
  const k8s: ImportK8s = {
    kubectl: async (args: string[], stdin?: string) => {
      if (!args.includes("--request-timeout=20s")) calls.untimed++;
      if (args.includes("nodes")) {
        calls.nodes++;
        if (opts.nodesError) return { code: 1, stdout: "", stderr: opts.nodesError };
        if (opts.nodesGarbled) return { code: 0, stdout: "not-json{", stderr: "" };
        const items = (opts.nodes ?? []).map((n) => {
          const f: NodeFixture = typeof n === "string" ? { name: n } : n;
          return {
            metadata: { name: f.name },
            spec: f.unschedulable ? { unschedulable: true } : {},
            status: {
              conditions: [{ type: "Ready", status: f.ready === false ? "False" : "True" }],
              nodeInfo: { operatingSystem: f.os ?? "linux" },
            },
          };
        });
        return { code: 0, stdout: JSON.stringify({ items }), stderr: "" };
      }
      if (args.includes("apply")) {
        calls.apply++;
        if (opts.applyCode) return { ...OK, code: opts.applyCode };
        const manifest = JSON.parse(stdin ?? "{}");
        const name = manifest.metadata?.name ?? "";
        const template = JSON.stringify(manifest.spec?.template ?? {});
        const existing = live.get(name);
        if (existing !== undefined && existing !== template) {
          return { code: 1, stdout: "", stderr: `Job.batch "${name}" is invalid: spec.template: field is immutable` };
        }
        live.set(name, template);
        applies.push(manifest);
        return OK;
      }
      if (args.includes("delete")) {
        calls.del++;
        const name = args[args.length - 1]!;
        deleted.push(name);
        live.delete(name);
        return OK;
      }
      if (args.includes("logs")) {
        calls.logs++;
        if (opts.logsThrow) throw new Error("logs unreachable");
        return { code: 0, stdout: opts.jobLogs ?? "", stderr: "" };
      }
      // get job -o json — the job name is the trailing `-- <name>` argument
      calls.get++;
      gets++;
      if (opts.getCode) return { code: opts.getCode, stdout: "", stderr: "jobs is forbidden" };
      const name = args[args.length - 1] ?? "";
      if (!live.has(name)) return { code: 1, stdout: "", stderr: `jobs.batch "${name}" not found` };
      const failed = opts.fail || (opts.failOn !== undefined && name.includes(opts.failOn));
      const status = failed ? { failed: 1 } : gets >= (opts.succeedAfter ?? 1) ? { succeeded: 1 } : {};
      return { code: 0, stdout: JSON.stringify({ status }), stderr: "" };
    },
  };
  return { k8s, calls, applies, deleted };
}

const importArgs = (k8s: ImportK8s, over = {}) => ({
  k8s,
  presignedUrl: "https://r2/pay.tar?sig=x",
  service: "pay",
  namespace: "default",
  tag: "v1",
  delay: noDelay,
  pollTicks: 5,
  tickMs: 1,
  ...over,
});

const spec = () => ({
  service: "pay",
  namespace: "default",
  tag: "v1.2.3",
  tarUrl: "https://r2.example.com/pay/v1.2.3/pay.tar?X-Amz-Signature=secret",
});

describe("importJobName", () => {
  it("is deterministic, lowercased, and a valid (≤63 char) k8s name", () => {
    const n = importJobName("pay", "v1.2.3");
    expect(n).toBe(importJobName("pay", "v1.2.3"));
    expect(n.length).toBeLessThanOrEqual(63);
    expect(n).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("sanitizes registry-style tags with slashes and uppercase", () => {
    const n = importJobName("svc", "Feature/Branch_01");
    expect(n).toMatch(/^[a-z0-9-]+$/);
    expect(n).not.toContain("/");
    expect(n).not.toContain("_");
  });

  it("gives distinct nodes distinct names even when slugs would collide (dots vs dashes, truncation)", () => {
    // `node.a` and `node-a` slug to the same string — the segment must stay injective.
    expect(importJobName("pay", "v1", "node.a")).not.toBe(importJobName("pay", "v1", "node-a"));
    const long = ["node-" + "a".repeat(60) + "x", "node-" + "a".repeat(60) + "y"];
    const names = long.map((n) => importJobName("some-service-name", "release/2026.08.08", n));
    expect(new Set(names).size).toBe(2);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(63);
      expect(n).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    }
  });
});

describe("buildBundleImportJob", () => {
  const job = buildBundleImportJob(spec()) as any;

  it("emits a VALID k8s label value even for a dotted/trailing-dash service name", () => {
    const LABEL = /^[a-z0-9A-Z]([a-z0-9A-Z._-]{0,61}[a-z0-9A-Z])?$/;
    for (const svc of ["my.svc-", "a".repeat(80), "UPPER.Case"]) {
      const j = buildBundleImportJob({ ...spec(), service: svc }) as any;
      const v = j.metadata.labels["celeste-hyper.io/service"];
      expect(v.length).toBeLessThanOrEqual(63);
      expect(v).toMatch(LABEL);
    }
  });

  it("is a one-shot Job that never retries and self-deletes", () => {
    expect(job.kind).toBe("Job");
    expect(job.metadata.name).toBe(importJobName("pay", "v1.2.3"));
    expect(job.metadata.namespace).toBe("default");
    expect(job.metadata.labels["app.kubernetes.io/managed-by"]).toBe("celeste-hyper");
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.activeDeadlineSeconds).toBeGreaterThan(0);
    expect(job.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(job.spec.template.spec.restartPolicy).toBe("Never");
    expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it("names a node-pinned Job with the SAME node the caller polls (metadata.name carries the node)", () => {
    const j = buildBundleImportJob({ ...spec(), nodeName: "node-a" }) as any;
    expect(j.metadata.name).toBe(importJobName("pay", "v1.2.3", "node-a"));
    expect(j.metadata.name).not.toBe(importJobName("pay", "v1.2.3"));
  });

  it("mounts the node containerd socket (Socket), the node's k3s binary (File), and a scratch emptyDir", () => {
    const vols = job.spec.template.spec.volumes;
    const sock = vols.find((v: any) => v.name === "containerd-sock");
    expect(sock.hostPath.path).toBe(K3S_CONTAINERD_SOCKET);
    expect(sock.hostPath.type).toBe("Socket");
    const bin = vols.find((v: any) => v.name === "k3s-bin");
    expect(bin.hostPath.path).toBe(K3S_HOST_BINARY);
    expect(bin.hostPath.type).toBe("File");
    expect(vols.some((v: any) => v.emptyDir)).toBe(true);
  });

  it("runs a single container (no 250 MB image pull) as root+privileged", () => {
    const cs = job.spec.template.spec.containers;
    expect(cs).toHaveLength(1);
    expect(job.spec.template.spec.initContainers).toBeUndefined();
    expect(cs[0].securityContext).toEqual({ privileged: true, runAsUser: 0 });
    expect(cs[0].resources.limits["ephemeral-storage"]).toBeTruthy();
  });

  it("passes the presigned URL via env, NEVER as a container argument (no URL leak in argv)", () => {
    const c = job.spec.template.spec.containers[0];
    const urlEnv = c.env.find((e: any) => e.value === spec().tarUrl);
    expect(urlEnv).toBeTruthy();
    expect(urlEnv.name).toBe("TAR_URL");
    const argv = JSON.stringify([c.command, c.args]);
    expect(argv).not.toContain("X-Amz-Signature");
    expect(argv).not.toContain(spec().tarUrl);
    expect(argv).toContain("$TAR_URL"); // referenced, not inlined
  });

  it("fetches with curl then imports into the kubelet store via the node's `k3s ctr … images import`", () => {
    const c = job.spec.template.spec.containers[0];
    const cmd = JSON.stringify([c.command, c.args]);
    expect(cmd).toContain("curl");
    expect(cmd).toContain("/host/k3s ctr");
    expect(cmd).toContain("images");
    expect(cmd).toContain("import");
    expect(cmd).toContain("k8s.io");
    expect(cmd).toContain(K3S_CONTAINERD_SOCKET);
  });

  it("pins with nodeName when given; ALWAYS tolerates control-plane taints (pinned or fallback)", () => {
    const j = buildBundleImportJob({ ...spec(), nodeName: "node-a" }) as any;
    expect(j.spec.template.spec.nodeName).toBe("node-a");
    const keys = j.spec.template.spec.tolerations.map((t: any) => t.key);
    expect(keys).toContain("node-role.kubernetes.io/control-plane");
    const unpinned = buildBundleImportJob(spec()) as any;
    expect(unpinned.spec.template.spec.nodeName).toBeUndefined();
    // The fallback Job must also schedule on a tainted single-node cluster.
    const unpinnedKeys = unpinned.spec.template.spec.tolerations.map((t: any) => t.key);
    expect(unpinnedKeys).toContain("node-role.kubernetes.io/control-plane");
  });
});

describe("runRemoteBundleImport", () => {
  it("applies the import Job and returns ok once it succeeds, then always tears it down", async () => {
    const { k8s, calls } = importK8s({ succeedAfter: 2 });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(true);
    expect(calls.apply).toBe(1);
    expect(calls.del).toBe(2); // pre-apply delete (clean slate) + finally cleanup
    expect(calls.untimed).toBe(0); // every apiserver call is --request-timeout-bounded
  });

  it("fails (and does not poll) — but still cleans up — when the Job cannot be applied", async () => {
    const { k8s, calls } = importK8s({ applyCode: 1 });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(false);
    expect(calls.get).toBe(0);
    expect(calls.del).toBe(2); // pre-apply delete + apply-failure teardown (never leave a Job behind)
  });

  it("fails and cleans up when the Job reports failed, surfacing the pod logs", async () => {
    const { k8s, calls } = importK8s({ fail: true, jobLogs: "ctr: content digest sha256:abc: not found" });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("failed");
    expect(r.message).toContain("content digest"); // captured pod-log tail
    expect(calls.logs).toBe(1);
    expect(calls.del).toBe(2);
  });

  it("still fails cleanly if capturing the logs throws", async () => {
    const { k8s } = importK8s({ fail: true, logsThrow: true });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("failed");
  });

  it("times out (and cleans up) when the Job never completes", async () => {
    const { k8s, calls } = importK8s({ succeedAfter: 999 });
    const r = await runRemoteBundleImport(importArgs(k8s, { pollTicks: 3 }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("did not complete");
    expect(calls.del).toBe(2);
  });

  it("stops polling early when the wall-clock budget is exhausted (tick cost grows with node count)", async () => {
    let t = 0;
    const { k8s } = importK8s({ succeedAfter: 999 });
    const r = await runRemoteBundleImport(
      importArgs(k8s, { pollTicks: 9999, deadlineSec: 1, now: () => (t += 40_000) }),
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain("did not complete");
  });

  it("fails fast when a Job's status reads keep failing (lost/reaped Job, revoked RBAC)", async () => {
    const { k8s } = importK8s({ getCode: 1 });
    const r = await runRemoteBundleImport(importArgs(k8s, { pollTicks: 50 }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unreadable");
  });

  it("falls back to a single unpinned Job ONLY when node-listing is RBAC-forbidden", async () => {
    const { k8s, calls, applies } = importK8s({ nodesError: 'nodes is forbidden: User "x" cannot list resource "nodes"' });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(true);
    expect(calls.apply).toBe(1);
    expect(applies[0].spec.template.spec.nodeName).toBeUndefined();
  });

  it("FAILS the deploy on a transient node-list error — never silently imports to one node", async () => {
    const { k8s, calls } = importK8s({ nodesError: "dial tcp 10.0.0.1:6443: connection refused" });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("list nodes");
    expect(calls.apply).toBe(0);
  });

  it("FAILS the deploy when the node list comes back garbled", async () => {
    const { k8s, calls } = importK8s({ nodesGarbled: true });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(false);
    expect(calls.apply).toBe(0);
  });
});

describe("runRemoteBundleImport (multi-node)", () => {
  const NODES = ["node-a", "node-b", "node-c"];

  it("applies one nodeName-pinned Job per Ready node and succeeds only when ALL complete", async () => {
    const { k8s, calls, applies, deleted } = importK8s({ nodes: NODES });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(true);
    expect(r.message).toContain("3 node(s)");
    expect(calls.apply).toBe(3);
    const pinned = applies.map((j) => j.spec.template.spec.nodeName).sort();
    expect(pinned).toEqual(NODES);
    // Identity contract: every manifest gets its own name, and teardown targets exactly those names.
    const names = applies.map((j) => j.metadata.name);
    expect(new Set(names).size).toBe(3);
    expect([...new Set(deleted)].sort()).toEqual([...names].sort());
    // pre-apply clean slate + finally teardown, per Job
    expect(calls.del).toBe(6);
    expect(calls.untimed).toBe(0);
  });

  it("skips unschedulable, NotReady and non-Linux nodes", async () => {
    const { k8s, applies } = importK8s({
      nodes: [
        "node-a",
        { name: "node-b", unschedulable: true },
        { name: "node-c", ready: false },
        { name: "node-d", os: "windows" },
      ],
    });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(true);
    expect(applies.map((j) => j.spec.template.spec.nodeName)).toEqual(["node-a"]);
  });

  it("fails the whole import — and tears every Job down — when ANY node's Job fails", async () => {
    const { k8s, calls } = importK8s({ nodes: NODES, failOn: importJobName("pay", "v1", "node-b") });
    const r = await runRemoteBundleImport(importArgs(k8s));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("node-b");
    expect(calls.del).toBe(6);
  });
});
