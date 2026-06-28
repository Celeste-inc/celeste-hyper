import { Elysia } from "elysia";
import { z } from "zod";
import type { ApiDeps } from "./deps.ts";
import { authenticate } from "./auth.ts";
import { scanNetwork, DEFAULT_PORTS, DEFAULT_TIMEOUT_MS } from "../services/network-scan.ts";
import { log } from "../lib/logger.ts";

const CONSENT = "scan-acknowledged";

const ScanBody = z.object({
  targets: z.array(z.string().min(1)).min(1).max(256),
  ports: z.array(z.number().int().min(1).max(65535)).min(1).max(16).optional(),
  timeoutMs: z.number().int().min(100).max(10_000).optional(),
  consent: z.string().optional(),
});

export const discoveryRoutes = (deps: ApiDeps) =>
  new Elysia().post(
    "/discovery/scan",
    async ({ body, status, request }) => {
      const parsed = ScanBody.safeParse(body ?? {});
      if (!parsed.success) return status(422, { error: "invalid body", issues: parsed.error.issues });
      // Opt-in gate: refuse to scan a network unless the operator explicitly acknowledges it.
      if (parsed.data.consent !== CONSENT) {
        return status(400, { error: "consent-required", message: `set "consent": "${CONSENT}" to run a scan` });
      }
      const ports = parsed.data.ports ?? DEFAULT_PORTS;
      const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // Capture the operator BEFORE the (up-to-60s) scan, so a token that expires/revokes mid-scan
      // can't make the audit record "unknown". (Persistent audit table is P2.1; structured log now.)
      const principal = await authenticate(request, deps);
      const result = await scanNetwork(parsed.data.targets, ports, timeoutMs, deps.netProbe);
      if ("error" in result) return status(400, { error: "invalid-targets", message: result.error });
      log.info("discovery.scan", {
        user: principal?.username ?? "unknown",
        targets: parsed.data.targets,
        ports,
        ipsScanned: result.ipsScanned,
        tuplesScanned: result.tuplesScanned,
        candidates: result.candidates.length,
      });
      return result;
    },
    { detail: { summary: "Scan IPs/CIDRs for Kubernetes API servers (admin only, consent-gated)", tags: ["discovery"] } },
  );
