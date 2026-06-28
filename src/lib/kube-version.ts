// Kubernetes version-skew policy (CC.5). kubectl is supported within ±1 minor of the apiserver, and
// we require a minimum kubectl of 1.30 (matches the k3s 1.31 API surface this dashboard targets).
export const MIN_KUBECTL = "1.30";
const MIN_MAJOR = 1;
const MIN_MINOR = 30;
const MAX_MINOR_SKEW = 1;

export interface KubeMinor {
  major: number;
  minor: number;
}

const VERSION_RE = /v?(\d+)\.(\d+)/;

/** Parse the major.minor out of a gitVersion ("v1.31.13+k3s1") or a bare "1.30"; null if unrecognisable. */
export function parseKubeMinor(gitVersion: string | null | undefined): KubeMinor | null {
  if (!gitVersion) return null;
  const m = VERSION_RE.exec(gitVersion);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Pull client/server gitVersion out of `kubectl version -o json` (either may be absent / non-JSON). */
export function parseKubectlVersion(stdout: string): { client: string | null; server: string | null } {
  try {
    const o = JSON.parse(stdout);
    if (!o || typeof o !== "object" || Array.isArray(o)) return { client: null, server: null };
    const v = o as { clientVersion?: { gitVersion?: string }; serverVersion?: { gitVersion?: string } };
    return { client: v.clientVersion?.gitVersion ?? null, server: v.serverVersion?.gitVersion ?? null };
  } catch {
    return { client: null, server: null };
  }
}

/** True if the kubectl client meets the documented minimum. Unknown/unparseable → true (no false alarm). */
export function isClientSupported(clientGit: string | null): boolean {
  const c = parseKubeMinor(clientGit);
  if (!c) return true;
  if (c.major !== MIN_MAJOR) return c.major > MIN_MAJOR;
  return c.minor >= MIN_MINOR;
}

export interface SkewVerdict {
  client: string | null;
  server: string | null;
  ok: boolean;
  reason: string | null;
}

/** Verdict for a (kubectl client, apiserver) pair: below-minimum or >±1-minor skew is not ok. */
export function evaluateSkew(clientGit: string | null, serverGit: string | null): SkewVerdict {
  const base = { client: clientGit, server: serverGit };
  if (!isClientSupported(clientGit)) {
    return { ...base, ok: false, reason: `kubectl ${clientGit} is below the minimum supported ${MIN_KUBECTL}` };
  }
  const c = parseKubeMinor(clientGit);
  const s = parseKubeMinor(serverGit);
  if (!c || !s) return { ...base, ok: true, reason: null }; // can't compare → don't warn
  if (c.major !== s.major) {
    return { ...base, ok: false, reason: `kubectl ${clientGit} major differs from server ${serverGit}` };
  }
  if (Math.abs(c.minor - s.minor) > MAX_MINOR_SKEW) {
    return { ...base, ok: false, reason: `kubectl ${clientGit} is >${MAX_MINOR_SKEW} minor from server ${serverGit}` };
  }
  return { ...base, ok: true, reason: null };
}
