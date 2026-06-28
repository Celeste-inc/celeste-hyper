import { log } from "../lib/logger.ts";

export type Distribution = "k3s" | "k8s" | "microk8s" | "rke2" | "unknown";

export const DEFAULT_PORTS = [6443, 8443, 16443]; // k3s/kubeadm, microk8s/RKE2, microk8s
export const DEFAULT_TIMEOUT_MS = 1500;
export const MAX_IPS = 1024;
export const DEFAULT_DEADLINE_MS = 60_000; // total wall-clock budget for a scan (the plan's cap)
const MAX_INFLIGHT = 64;
const MAX_PROBE_BODY = 64 * 1024; // a /version response is tiny; never buffer a hostile responder's flood
const AUTH_METHODS = ["bearer-token", "client-cert"]; // we can't know more without authenticating

export interface Candidate {
  ip: string;
  port: number;
  reachable: boolean;
  serverVersion: string | null;
  distribution: Distribution;
  authMethods: string[];
  ms: number;
}

/** Outcome of a single TCP+TLS+HTTP `/version` probe (the I/O half, injected for testability). */
export interface ProbeResult {
  reachable: boolean; // did the TLS port accept a connection within the timeout
  ms: number;
  body?: string; // the raw `/version` response body, if one came back
}

export type VersionProbe = (ip: string, port: number, timeoutMs: number) => Promise<ProbeResult>;

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/**
 * Expand a list of IPv4 addresses and CIDR blocks into a de-duplicated IP list, bounded by `cap`
 * (default 1024) to keep a scan cheap. Returns a precise error string for an invalid target or when
 * the expansion would exceed the cap — the caller surfaces it as a 400. IPv6 is out of scope in v1.
 */
export function expandTargets(targets: string[], cap = MAX_IPS): { ips: string[] } | { error: string } {
  const out = new Set<string>();
  for (const raw of targets) {
    const t = raw.trim();
    if (!t) continue;
    const slash = t.indexOf("/");
    if (slash < 0) {
      if (ipToInt(t) === null) return { error: `invalid target '${t}' (expected an IPv4 address or CIDR)` };
      out.add(t);
      if (out.size > cap) return { error: `scan exceeds the ${cap}-IP cap` };
      continue;
    }
    const base = t.slice(0, slash);
    const bits = Number(t.slice(slash + 1));
    const baseN = ipToInt(base);
    if (baseN === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return { error: `invalid CIDR '${t}'` };
    const size = 2 ** (32 - bits);
    // Reject a single oversize block before expanding it (no OOM); overlapping blocks still dedup
    // under the cap because we re-check the actual unique count after each expansion.
    if (size > cap) return { error: `CIDR '${t}' alone exceeds the ${cap}-IP cap (${size} addresses)` };
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const network = (baseN & mask) >>> 0;
    for (let i = 0; i < size; i++) out.add(intToIp((network + i) >>> 0));
    if (out.size > cap) return { error: `scan exceeds the ${cap}-IP cap` };
  }
  return { ips: [...out] };
}

/** Infer the Kubernetes distribution from a server `gitVersion` (e.g. `v1.31.13+k3s1`). */
export function fingerprintDistribution(gitVersion: string): Distribution {
  const v = gitVersion.toLowerCase();
  if (v.includes("k3s")) return "k3s";
  if (v.includes("rke2")) return "rke2";
  if (v.includes("microk8s")) return "microk8s";
  return "k8s";
}

/** True if a parsed `/version` body has the documented apiserver shape. */
function isVersionShape(body: unknown): body is { major: string; minor: string; gitVersion: string } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.major === "string" && typeof b.minor === "string" && typeof b.gitVersion === "string";
}

/** Turn a raw probe result into a classified candidate (pure — no I/O). */
export function classifyProbe(ip: string, port: number, r: ProbeResult): Candidate {
  const base = { ip, port, authMethods: AUTH_METHODS, ms: r.ms };
  if (!r.reachable) return { ...base, reachable: false, serverVersion: null, distribution: "unknown" };
  if (r.body) {
    try {
      const parsed = JSON.parse(r.body);
      if (isVersionShape(parsed)) {
        return { ...base, reachable: true, serverVersion: parsed.gitVersion, distribution: fingerprintDistribution(parsed.gitVersion) };
      }
    } catch {
      // not JSON — a reachable TLS port that isn't a Kubernetes apiserver
    }
  }
  return { ...base, reachable: true, serverVersion: null, distribution: "unknown" };
}

/** Run `fn` over `items` with at most `limit` in flight, stopping once `isExpired()` is true. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  isExpired: () => boolean,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length || isExpired()) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ScanResult {
  candidates: Candidate[];
  tuplesScanned: number;
  ipsScanned: number;
  timedOut: boolean;
}

/**
 * Expand targets, probe every (ip, port) for a Kubernetes apiserver (bounded concurrency), and
 * return the reachable candidates. Returns `{ error }` for an invalid target / cap overflow.
 */
export async function scanNetwork(
  targets: string[],
  ports: number[],
  timeoutMs: number,
  probe: VersionProbe,
  deadlineMs: number = DEFAULT_DEADLINE_MS,
): Promise<ScanResult | { error: string }> {
  const expanded = expandTargets(targets);
  if ("error" in expanded) return expanded;
  const tuples: Array<{ ip: string; port: number }> = [];
  for (const ip of expanded.ips) for (const port of ports) tuples.push({ ip, port });
  const start = performance.now();
  const isExpired = () => performance.now() - start > deadlineMs;
  const classified = await mapLimit(tuples, MAX_INFLIGHT, isExpired, async ({ ip, port }) => {
    try {
      return classifyProbe(ip, port, await probe(ip, port, timeoutMs));
    } catch {
      return classifyProbe(ip, port, { reachable: false, ms: timeoutMs });
    }
  });
  const done = classified.filter((c): c is Candidate => c !== undefined);
  return {
    candidates: done.filter((c) => c.reachable),
    tuplesScanned: done.length, // tuples actually probed (< total if the deadline cut it short)
    ipsScanned: expanded.ips.length,
    timedOut: done.length < tuples.length,
  };
}

/**
 * Real probe: a TLS connection (certificate verification skipped — we're fingerprinting, not
 * trusting) + an anonymous `GET /version`. Never throws — connection/timeout failures map to
 * `reachable:false`. Not exercised by the test suite (network is blocked there); the scan logic is
 * tested via an injected probe.
 */
/** Read at most `max` bytes of a response body, cancelling the rest. Bounds a hostile flood. */
export async function readBounded(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const c of chunks) {
    buf.set(c.subarray(0, buf.length - offset), offset);
    offset += c.byteLength;
    if (offset >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

export const realVersionProbe: VersionProbe = async (ip, port, timeoutMs) => {
  const startedAt = performance.now();
  try {
    const res = await fetch(`https://${ip}:${port}/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual", // never chase a malicious host's redirect off the bounded target set (SSRF)
      tls: { rejectUnauthorized: false }, // Bun: skip cert verification for probing
    });
    const body = await readBounded(res, MAX_PROBE_BODY);
    // We got an HTTP response (any status, incl. a 3xx with redirect:manual) → the port answered.
    return { reachable: true, ms: Math.round(performance.now() - startedAt), body };
  } catch (e) {
    // Anything that prevents completing the request — connect refused, timeout, TLS/protocol error
    // — is "not a usable endpoint". Classifying off the response (above) rather than fragile,
    // Bun-version-specific error strings avoids surfacing dead hosts as promotable candidates.
    log.debug("discovery.probe_error", { ip, port, error: (e as Error).message });
    return { reachable: false, ms: Math.round(performance.now() - startedAt) };
  }
};
