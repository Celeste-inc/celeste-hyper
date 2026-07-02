import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const scripts = ["deploy/bootstrap.sh", "deploy/install.sh", "deploy/update.sh", "deploy/join.sh", "scripts/fleet-sim.sh", "scripts/fleet-worker-init.sh", "scripts/enroll-stress.sh"];

/** Parse-check every shell script with `bash -n` (catches syntax breakage in CI without a VM). */
describe("deploy shell scripts", () => {
  for (const s of scripts) {
    it(`${s} parses under bash -n`, () => {
      const r = Bun.spawnSync(["bash", "-n", join(root, s)]);
      expect(r.stderr.toString()).toBe("");
      expect(r.exitCode).toBe(0);
    });
  }

  it("join.sh uses strict mode and is safe by construction", () => {
    const src = readFileSync(join(root, "deploy", "join.sh"), "utf8");
    expect(src).toContain("set -euo pipefail");
    expect(src).toContain("/api/enroll");
    // hardening codex asked for: pin the cert to the LAN IP, write the kubeconfig 0600, warn on http.
    expect(src).toContain("--tls-san");
    expect(src).toContain("--write-kubeconfig-mode 0600");
    expect(src).toMatch(/http:\/\/\*\)/); // the plaintext-MASTER_URL warning branch
    // the kubeconfig must be JSON-encoded via jq, never hand-concatenated into the body
    expect(src).toContain("jq -n");
    expect(src).toContain("--data-binary @-");
    expect(src).not.toContain('--data-binary "${body}"');
  });
});
