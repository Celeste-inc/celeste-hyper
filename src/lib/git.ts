import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { RunResult } from "./k8s.ts";

/** Thin async runner for `git` (injected for testability). `cwd`/`sshKey` scope each invocation. */
export interface GitLike {
  run(args: string[], opts?: { cwd?: string; sshKey?: string }): Promise<RunResult>;
}

export type GitValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate a git remote URL against the host allowlist (SSRF guard). Supports `https://host/…`,
 * `ssh://git@host[:port]/…`, and the scp-like `git@host:path` form. An **empty allowlist disables
 * git-sync entirely** (every URL is refused). Hosts compare case-insensitively, port-stripped.
 */
// Only secure network transports. Excludes `ext::`/`fd::` (RCE), `file://` (local-FS SSRF), and the
// cleartext `http://`/`git://` (MITM). The scp form `git@host:path` is treated as ssh.
const ALLOWED_SCHEMES = new Set(["https:", "ssh:", "git+ssh:"]);

export function validateGitUrl(url: string, allowlist: string[]): GitValidation {
  if (allowlist.length === 0) return { ok: false, error: "git-sync is disabled (HYPER_GIT_HOST_ALLOWLIST is empty)" };
  const u = url.trim();
  if (/\s/.test(u)) return { ok: false, error: "git url must not contain whitespace" };
  // A scheme URL must use an allowed transport; the scp form (git@host:path) has no `://` and skips this.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    let proto: string;
    try {
      proto = new URL(u).protocol.toLowerCase();
    } catch {
      return { ok: false, error: `could not parse git url '${url}'` };
    }
    if (!ALLOWED_SCHEMES.has(proto)) return { ok: false, error: `unsupported git transport '${proto.replace(":", "")}'` };
  } else if (/^[a-z][a-z0-9+.-]*::/i.test(u)) {
    return { ok: false, error: "unsupported git transport" }; // ext::/fd:: command transports
  }
  const host = gitHost(u);
  if (host === null) return { ok: false, error: `could not parse a host from git url '${url}'` };
  const allowed = new Set(allowlist.map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (!allowed.has(host)) return { ok: false, error: `git host '${host}' is not in the allowlist` };
  return { ok: true };
}

/**
 * Extract the lowercased host from a git URL. For scheme URLs we use the platform `URL` parser (NOT
 * a hand-rolled regex): the WHATWG parser terminates the authority at `#`/`?` exactly as git/curl do,
 * so `https://evil.com#@github.com/` correctly resolves to `evil.com` (a regex userinfo group is
 * fooled into returning `github.com` — a real allowlist bypass). The scp form has no scheme.
 */
export function gitHost(url: string): string | null {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return h || null;
    } catch {
      return null;
    }
  }
  // scp-like: [user@]host:path  (host has no slash before the first colon, and it's not `scheme::`)
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*::/i.test(u)) return scp[1]!.toLowerCase();
  return null;
}

/**
 * Validate a repo-relative manifest path: no absolute paths, no `..` segments, no leading slash, and
 * it must resolve *under* the (eventual) clone root. Returns the normalized relative path on success.
 */
export function validateGitPath(gitPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const p = gitPath.trim();
  if (p === "" || p === ".") return { ok: true, path: "." };
  if (p.startsWith("/")) return { ok: false, error: "gitPath must be repo-relative (no leading slash)" };
  if (p.split(/[\\/]/).some((seg) => seg === "..")) return { ok: false, error: "gitPath must not contain '..' segments" };
  // Defense in depth: confirm it resolves under a probe root.
  const root = "/__repo_root__";
  const resolved = resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + sep)) return { ok: false, error: "gitPath escapes the repository root" };
  return { ok: true, path: p };
}

/** A deploy key path must resolve to a file strictly inside `keysDir` (path-traversal guard). */
export function validateDeployKeyPath(keyPath: string, keysDir: string): GitValidation {
  const root = resolve(keysDir);
  const resolved = resolve(root, keyPath);
  if (resolved !== root && !resolved.startsWith(root + sep)) return { ok: false, error: "key-outside-allowed-dir" };
  if (resolved === root) return { ok: false, error: "key-outside-allowed-dir" };
  return { ok: true };
}

/** Parse `git ls-remote <url> <ref>` output → the 40-hex SHA for the ref, or null. */
export function parseLsRemote(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const m = /^([0-9a-f]{40})\s+/.exec(line.trim());
    if (m) return m[1]!;
  }
  return null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STDOUT = 4 * 1024 * 1024;

/**
 * Real `git` runner. A deploy key (validated path) is passed via `GIT_SSH_COMMAND` so it never
 * touches the argv/shell. Host-key checking is disabled for the probe — the host allowlist is the
 * trust boundary. Bounded by a timeout + stdout cap.
 */
export class Git implements GitLike {
  run(args: string[], opts: { cwd?: string; sshKey?: string } = {}): Promise<RunResult> {
    return new Promise((resolveP, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      if (opts.sshKey) {
        env.GIT_SSH_COMMAND = `ssh -i ${shellQuote(opts.sshKey)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
      }
      const child = spawn("git", args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      const killTimer = setTimeout(() => (child.kill("SIGKILL"), resolveP({ code: 124, stdout, stderr: stderr || "git timed out" })), DEFAULT_TIMEOUT_MS);
      child.stdout.on("data", (b) => {
        if (stdout.length > MAX_STDOUT) {
          if (!overflow) (overflow = true), child.kill("SIGKILL");
          return;
        }
        stdout += b.toString();
      });
      child.stderr.on("data", (b) => (stderr += b.toString()));
      child.on("error", (e) => (clearTimeout(killTimer), reject(e)));
      child.on("close", (code) => (clearTimeout(killTimer), resolveP(overflow ? { code: 1, stdout: "", stderr: "git output too large" } : { code: code ?? 1, stdout, stderr })));
    });
  }
}

/** Single-quote a value for safe interpolation into GIT_SSH_COMMAND. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
