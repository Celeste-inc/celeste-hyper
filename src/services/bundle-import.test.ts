import { describe, it, expect } from "bun:test";
import { buildBundleImportJob, importJobName, runRemoteBundleImport, K3S_CONTAINERD_SOCKET, K3S_HOST_BINARY, type ImportK8s } from "./bundle-import.ts";

const OK = { code: 0, stdout: "", stderr: "" };
const noDelay = async () => {};

/** Fake K8s over the single `kubectl` seam. Routes by argv: apply / get job / delete / logs. Every
 *  call also asserts it carries a `--request-timeout` bound (the HIGH-severity fix). */
function importK8s(opts: { applyCode?: number; succeedAfter?: number; fail?: boolean; jobLogs?: string; logsThrow?: boolean } = {}) {
  const calls = { apply: 0, get: 0, del: 0, logs: 0, untimed: 0 };
  let gets = 0;
  const k8s: ImportK8s = {
    kubectl: async (args: string[]) => {
      if (!args.includes("--request-timeout=20s")) calls.untimed++;
      if (args.includes("apply")) {
        calls.apply++;
        return { ...OK, code: opts.applyCode ?? 0 };
      }
      if (args.includes("delete")) {
        calls.del++;
        return OK;
      }
      if (args.includes("logs")) {
        calls.logs++;
        if (opts.logsThrow) throw new Error("logs unreachable");
        return { code: 0, stdout: opts.jobLogs ?? "", stderr: "" };
      }
      // get job -o json
      calls.get++;
      gets++;
      const status = opts.fail ? { failed: 1 } : gets >= (opts.succeedAfter ?? 1) ? { succeeded: 1 } : {};
      return { code: 0, stdout: JSON.stringify({ status }), stderr: "" };
    },
  };
  return { k8s, calls };
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
});
