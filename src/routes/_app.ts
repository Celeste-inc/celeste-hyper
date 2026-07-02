import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import type { ApiDeps } from "./deps.ts";
import { systemRoutes } from "./system.ts";
import { clusterRoutes } from "./clusters.ts";
import { serviceRoutes } from "./services.ts";
import { deploymentRoutes } from "./deployments.ts";
import { serviceOpsRoutes } from "./service-ops.ts";
import { envRoutes } from "./env.ts";
import { integrationRoutes } from "./integrations.ts";
import { registryRoutes } from "./registries.ts";
import { fleetRoutes } from "./fleet.ts";
import { templateRoutes } from "./templates.ts";
import { registrySourceRoutes } from "./registry-sources.ts";
import { scalingRoutes } from "./scaling.ts";
import { discoveryRoutes } from "./discovery.ts";
import { enrollmentRoutes } from "./enrollment.ts";
import { helmRoutes } from "./helm.ts";
import { auditRoutes } from "./audit.ts";
import { setupRoutes } from "./setup.ts";
import { authRoutes, authenticate, isAuthCarveout, csrfEqual } from "./auth.ts";
import { requiredRole, hasRole, isMutation } from "./role-map.ts";
import { withinScope } from "./scope.ts";
import { recordHttpAudit } from "./audit.ts";
import { staticAssets } from "./ui.ts";

export type { ApiDeps } from "./deps.ts";

const OPENAPI_TAGS = [
  { name: "system", description: "Health and runtime info" },
  { name: "clusters", description: "Cluster registry" },
  { name: "services", description: "Service registry and versions" },
  { name: "deployments", description: "Deploys and deployment history" },
  { name: "service-ops", description: "Pods, networking, and log streaming" },
  { name: "env", description: "Per-service env files" },
  { name: "integrations", description: "Machine tokens and registry webhooks" },
  { name: "discovery", description: "Network scan for Kubernetes API servers" },
  { name: "enrollment", description: "Fleet enrollment — worker self-registration tokens" },
  { name: "helm", description: "Helm release operations" },
  { name: "audit", description: "Audit trail of mutations" },
  { name: "setup", description: "First-run setup and R2 settings" },
];

export function buildApp(deps: ApiDeps) {
  const api = new Elysia({ prefix: "/api" })
    // Resolve the caller once per request (per-request context, not the global store) so the guard
    // and the audit hook share one identity without re-authenticating.
    .derive(async ({ request }) => ({ principal: await authenticate(request, deps) }))
    // Auth guard (registered before the route plugins so it covers all of them). Carve-outs
    // (health/login/version) are public; everything else needs a valid session/bearer, the
    // required role, and — for cookie-auth mutations — a matching CSRF token.
    .onBeforeHandle(({ request, status, principal }) => {
      const path = new URL(request.url).pathname;
      if (isAuthCarveout(path)) return;
      if (!principal) return status(401, { error: "unauthorized" });
      // Role enforcement (P0.5).
      if (!hasRole(principal.role, requiredRole(request.method, path))) return status(403, { error: "forbidden" });
      // Scope enforcement (P1.10): a scoped machine token may only act within its service/cluster.
      if (!withinScope(principal, path, deps)) return status(403, { error: "out_of_scope" });
      // CSRF: cookie-auth mutations must present a matching X-CSRF-Token; bearer clients are exempt.
      if (principal.source === "cookie" && isMutation(request.method)) {
        const provided = request.headers.get("x-csrf-token");
        if (!provided) return status(403, { error: "csrf_missing" });
        if (!principal.csrf || !csrfEqual(provided, principal.csrf)) return status(403, { error: "csrf_invalid" });
      }
    })
    // Audit every mutation (P2.1) at the response boundary, with the final status as the outcome.
    .onAfterResponse(({ request, principal, set }) => recordHttpAudit(deps, request, principal ?? null, set.status))
    .use(systemRoutes(deps))
    .use(authRoutes(deps))
    .use(clusterRoutes(deps))
    .use(serviceRoutes(deps))
    .use(deploymentRoutes(deps))
    .use(serviceOpsRoutes(deps))
    .use(envRoutes(deps))
    .use(integrationRoutes(deps))
    .use(registryRoutes(deps))
    .use(fleetRoutes(deps))
    .use(templateRoutes(deps))
    .use(registrySourceRoutes(deps))
    .use(scalingRoutes(deps))
    .use(discoveryRoutes(deps))
    .use(enrollmentRoutes(deps))
    .use(helmRoutes(deps))
    .use(auditRoutes(deps))
    .use(setupRoutes(deps));

  return new Elysia()
    .onError(({ code, error, set }) => {
      // VALIDATION fires only when a route declares a TypeBox schema. Today validation lives in
      // zod inside handlers (which already return 422 with { error, issues }); this branch keeps
      // the same shape for when schema-typed routes land in later P0 items.
      if (code === "VALIDATION") {
        const all = (error as { all?: unknown }).all;
        set.status = 422;
        return { error: "invalid body", issues: Array.isArray(all) ? all : [] };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "not found" };
      }
      if (code === "PARSE") {
        // malformed JSON body — keep the { error, issues } shape clients saw under Hono
        set.status = 400;
        return { error: "invalid body", issues: [] };
      }
      set.status = 500;
      return { error: "internal error" };
    })
    .use(
      openapi({
        path: "/openapi",
        documentation: {
          info: { title: "celeste-hyper API", version: "0.1.0" },
          tags: OPENAPI_TAGS,
        },
      }),
    )
    .use(api)
    .use(staticAssets());
}
