# HTTP API reference

All endpoints are mounted under `/api`. Requests and responses are JSON unless noted otherwise.

Since P0.4 every `/api/*` route requires authentication except the carve-outs `/api/health`,
`/api/login`, `/api/version`, and token-authenticated carve-outs such as `/api/enroll`. Authenticate with the `hyper_session` cookie (set by
`POST /api/login`) or an `Authorization: Bearer <jwt>` header. Unauthenticated requests get
`401 { "error": "unauthorized" }`. See [Authentication](#authentication). Still run hyper
behind TLS (reverse proxy / Cloudflare Tunnel).

## Conventions

- IDs are URL-safe lowercase strings matching `[a-z0-9.-]+`.
- Errors use `{ "error": "...", "issues"?: [...] }` with the relevant HTTP status code.
- Request bodies that fail schema validation return `422` with `{ "error": "invalid body", "issues": [...] }` (since P0.B / Elysia). Business-rule rejections keep their specific codes: `400` (e.g. unknown cluster, immutable id, `sourceType` change), `404` (not found), `409` (duplicate / still-referenced).
- All timestamps are ISO 8601 strings in UTC.

## Authentication

Sessions are HS256 JWTs (12 h, argon2id password hashes) issued as an `HttpOnly`,
`SameSite=Lax` cookie (`Secure` when behind TLS). The cookie value *is* the bearer — CLI/automation
read it from the login `Set-Cookie` and send it as `Authorization: Bearer <jwt>`.

**First-run default admin.** On first boot with no users, hyper auto-creates a temporary
`admin` / `admin` with `mustChangePassword=true` and logs a warning. The UI forces a password
change before anything else; change it immediately.

### `POST /api/login`

```json
{ "username": "admin", "password": "..." }
```

`200 { "username", "role", "mustChangePassword" }` and a `Set-Cookie: hyper_session=...`.
`401` on bad/unknown credentials (no user-enumeration). Rate-limited to 5 attempts per minute
**per client IP and per username** (`429` beyond either).

### `GET /api/me`

Requires auth. `200 { "username", "role", "mustChangePassword" }`; `401` otherwise.

### `POST /api/change-password`

Requires auth. Verifies the current password, requires `newPassword` ≥ 8 chars, and clears
`mustChangePassword`.

```json
{ "currentPassword": "admin", "newPassword": "..." }
```

`200 { "ok": true }`; `401` if the current password is wrong; `422` if the new one is too short.

### `POST /api/logout`

Clears the session cookie (`Set-Cookie` with `Max-Age=0`). `200 { "ok": true }`.

### Roles & CSRF (P0.5)

Roles are `admin` > `operator` > `viewer`. Reads (`GET`) require `viewer`; mutations require
`operator`; a disallowed role gets `403 { "error": "forbidden" }`. (`GET /api/me` also returns
`csrfToken`.)

Cookie-authenticated **mutations** must send `X-CSRF-Token` equal to the per-session `csrfToken`
from `GET /api/me`; missing or wrong → `403 { "error": "csrf_missing" | "csrf_invalid" }`.
Bearer-token (CLI/automation) clients are **exempt** from CSRF — a browser cannot forge their
`Authorization` header.

When hyper sits behind a reverse proxy or Cloudflare Tunnel, configure it so forwarding headers are
overwritten, not appended from user input. Set `HYPER_TRUST_X_FORWARDED=1` only in that topology; direct
deployments ignore `X-Forwarded-*` for enrollment rate-limit identity.

## Health & system

### `GET /api/health`

Liveness probe + runtime introspection. Unauthenticated (so k8s probes reach it); `ok` is always present, the rest is non-secret operational metadata.

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptimeSec": 384,
  "lastTickAt": "2026-06-28T01:04:06.839Z",
  "clusterCount": 2,
  "jobCount": 0
}
```

`lastTickAt` is `null` before the first poller tick. `jobCount` is the number of pending+running background jobs. `uptimeSec` is whole seconds since process start.

### `GET /api/system`

Aggregate runtime info.

```json
{
  "clusters": 2,
  "poller": { "enabled": true, "intervalSec": 15, "autoDeploy": false,
              "lastTickAt": "2026-06-28T01:04:06.839Z",
              "lastDurationMs": 84, "lastError": null },
  "r2":     { "endpoint": "https://...", "bucket": "..." }
}
```

## Clusters

### `GET /api/clusters`

Returns every registered cluster with its current health pill and how many services point at it.

```json
{
  "items": [
    {
      "id": "primary",
      "name": "Primary (default)",
      "kubeconfigPath": "/kubeconfig/primary/kubeconfig",
      "defaultNamespace": "default",
      "runtime": "docker",
      "enabled": true,
      "health": { "clusterId": "primary", "ok": true, "reachable": true,
                  "message": "ok", "checkedAt": "2026-06-28T01:04:06.839Z" },
      "serviceCount": 1,
      "capabilities": {
        "hpaV2": { "value": true, "source": "cluster", "lastCheckedAt": "2026-06-28T01:04:06.9Z" },
        "ingressV1": { "value": true, "source": "cluster", "lastCheckedAt": "2026-06-28T01:04:06.9Z" },
        "metricsServerV1Beta1": { "value": false, "source": "cluster", "lastCheckedAt": "2026-06-28T01:04:06.9Z" },
        "helmCli": { "value": true, "source": "host", "lastCheckedAt": "2026-06-28T01:00:00.0Z" }
      },
      "capabilitiesCheckedAt": "2026-06-28T01:04:06.9Z",
      "kubectlVersion": "v1.31.0",
      "serverVersion": "v1.31.13+k3s1",
      "versionSkew": { "client": "v1.31.0", "server": "v1.31.13+k3s1", "ok": true, "reason": null }
    }
  ]
}
```

`capabilities` merges cluster-level records (from `kubectl api-versions`) and host-level CLI
records (`helmCli`/`k3sCli`/`ctrCli`, from `which`). Each is `{ value, source, lastCheckedAt, error? }`.
The UI gates affordances (HPA, Helm) on these rather than assuming support.

`kubectlVersion` is the host kubectl client version (probed once at boot); `serverVersion` is each
cluster's apiserver version (probed via `kubectl version -o json` during the capability refresh).
`versionSkew.ok` is false when kubectl is below the minimum supported **1.30** or more than ±1 minor
from the apiserver (the Kubernetes version-skew policy); the cluster card shows a warning pill. Either
version may be `null` until probed, in which case `versionSkew.ok` is `true` (no false alarm).

Each item also carries (additive, P4): `imageLoad` (`"local"` | `"remote-pull"` — how r2-bundle images
reach the node), `origin` (`"manual"` | `"enrolled"` — how the cluster was registered), and, for
enrolled clusters, `enrolledAt`. `imageLoad`/`origin` are always present (normalized; pre-P4 rows read
as `local`/`manual`). `origin`/`enrolledAt` are server-owned — they cannot be set via `POST`/`PATCH`.

### `POST /api/clusters`

Body — all fields required:

```json
{
  "id": "prod",
  "name": "Production VM 1",
  "kubeconfigPath": "/etc/celeste-hyper/clusters/prod.kubeconfig",
  "defaultNamespace": "default",
  "runtime": "k3s",
  "enabled": true
}
```

Returns `201 { "cluster": {...} }`. `409` if the id is taken. Registration triggers an immediate
capability probe, so the next `GET /api/clusters` reflects the new cluster's capabilities.

### `PATCH /api/clusters/:id`

Body is any subset of cluster fields. `id` cannot be changed.

### `DELETE /api/clusters/:id`

Refuses with `409` if any service still points at the cluster.

### `POST /api/clusters/:id/check`

Forces an immediate `kubectl --raw=/readyz` health check **and** a capability re-probe. Returns
`{ health, capabilities, lastCheckedAt }`.

### `GET /api/clusters/:id/namespaces`

Lists namespaces in a cluster with per-namespace counts (viewer-readable). Returns
`{ items: [{ name, phase, createdAt, deploymentCount, statefulsetCount, daemonsetCount, podCount }], truncated }`
(`createdAt` is the ISO creation time; the UI renders "age" from it). On a kubectl error it returns
`{ items: [], truncated: false, error }`. The dashboard's `?ns=a,b` filter narrows managed services
and discovered workloads to the selected namespaces.

### `POST /api/clusters/:id/workload-overrides`

Operator+. Pins a discovered workload's classification, overriding the default rules. Body
`{ namespace, kind: "Deployment"|"StatefulSet"|"DaemonSet", name, category: "application"|"infrastructure" }`
(`422` on a bad body, `404` on unknown cluster). Persisted in `workload_overrides`; adoption auto-writes
an `application` override.

### `GET /api/clusters/:id/ingresses/:namespace/:name`

Raw YAML of an Ingress object (`kubectl get ingress … -o yaml`). **Operator+** only — viewers get
`403`; an unknown ingress returns `404`; a non-RFC-1123 namespace/name returns `400`. Returns
`{ "yaml": "apiVersion: networking.k8s.io/v1\n..." }`. Backs the "View source" button on ingress
endpoints in the service detail.

## Fleet enrollment (P4)

Turn a fresh LAN machine into a managed cluster from the master. Token management is **admin-only**;
`/api/enroll` is an auth carve-out authenticated solely by the one-shot token (a worker has no session).
See [`clusters.md`](./clusters.md#fleet-enrollment-p4).

### `GET /api/enrollment-tokens`

`{ items: [{ id, name, clusterId, clusterName, defaultNamespace, runtime, imageLoad, createdAt,
expiresAt, usedAt, usedBy, revokedAt, status }] }`. `status` is derived (`active`|`used`|`revoked`|
`expired`). The HMAC hash is never returned.

### `POST /api/enrollment-tokens`

Body: `{ name, clusterId, clusterName?, defaultNamespace?="default", runtime?="k3s",
imageLoad?="remote-pull", expiresInMinutes?=30 }`. `400` if `clusterId` is already a registered cluster.
Returns `201 { token, joinCommand, enrollmentToken }` — the cleartext `token` and the paste-ready,
shell-escaped `joinCommand` are shown **once**.

### `DELETE /api/enrollment-tokens/:id`

Revokes an unused token → `{ revoked: true }`; `404` if it's already used/revoked or unknown.

### `POST /api/enroll` (carve-out)

Body: `{ token, kubeconfig, runtime?, nodeName? }`. Redeems the token (atomic, single-use), sanitizes
the kubeconfig (YAML-parsed object-graph walk — rejects `exec`/`auth-provider`/`proxy-url`/
`insecure-skip-tls-verify`/external file refs; requires `current-context` to resolve to declared
context/cluster/user entries, all clusters to use https with embedded `certificate-authority-data`, and
the effective user to use embedded static credentials), writes it `0600` under `clustersDir`, registers the cluster
(`origin: "enrolled"`, the token's `imageLoad`), runs the capability probe, and audits. Returns
`201 { cluster }`. `401` invalid/expired/used token · `400` bad kubeconfig · `409` cluster-id
collision · `413` body too large · `429` rate-limited. The token + kubeconfig are never logged/audited.

## Services

### `GET /api/services`

Returns the union of managed services and unmanaged cluster workloads. Discovered workloads are
split into `unmanaged` (application-category, adoptable) and `infrastructure` (cluster plumbing —
kube-system etc.; rendered collapsed). Classification follows the default rules unless an operator
override pins it.

```json
{
  "items": [
    {
      "name": "hello-world",
      "clusterId": "primary",
      "namespace": "default",
      "sourceType": "registry-pull",
      "imageRef": "traefik/whoami",
      "workloadKind": "Deployment",
      "workloadName": "hello-world",
      "containerName": "hello-world",
      "enabled": true,
      "currentTag": "v1.10.4",
      "deployedAt": "2026-06-28T01:04:37.448Z",
      "env": {
        "config": { "path": "/data/env/hello-world/config.env",
                    "exists": true,  "keys": ["LOG_LEVEL"] },
        "secret": { "path": "/data/env/hello-world/secret.env",
                    "exists": false, "keys": [] }
      },
      "cluster": { "kind": "Deployment", "replicas": 2, "readyReplicas": 2,
                   "containers": [{ "name": "hello-world",
                                    "image": "traefik/whoami:v1.10.4" }] },
      "newVersion": null
    }
  ],
  "unmanaged": [
    {
      "clusterId": "edge",
      "kind": "Deployment", "name": "edge-echo", "namespace": "edge-apps",
      "replicas": 1, "readyReplicas": 1,
      "containers": [{ "name": "edge-echo", "image": "traefik/whoami:v1.10" }],
      "managed": false,
      "suggestedName": "edge-echo",
      "suggestedImageRef": "traefik/whoami"
    }
  ],
  "lastTickAt": "2026-06-28T01:04:06.839Z"
}
```

### `GET /api/services/:name`

```json
{ "service": {...}, "currentTag": "v1.10.4",
  "deployedAt": "2026-06-28T01:04:37.448Z" }
```

### `POST /api/services`

Body — `clusterId` is required and must point at an existing cluster:

```json
{
  "sourceType": "r2-bundle",
  "name": "payments",
  "clusterId": "primary",
  "namespace": "default",
  "r2Prefix": "payments/",
  "enabled": true
}
```

…or:

```json
{
  "sourceType": "registry-pull",
  "name": "checkout",
  "clusterId": "primary",
  "namespace": "default",
  "imageRef": "myacr.azurecr.io/checkout",
  "imagePullSecret": "acr-pull",
  "enabled": true
}
```

The third source type, **`git-sync`** (P2.3), takes `{ gitUrl, gitRef (default "main"), gitPath
(default "."), deployKeyPath? }`. It is **security-gated** (see [`sources.md`](./sources.md#git-sync-in-detail-p23)):
the `gitUrl` host must be in `HYPER_GIT_HOST_ALLOWLIST` (empty ⇒ git-sync disabled), only
`https/http/ssh/git` transports are allowed, and `gitPath`/`deployKeyPath` are traversal-checked.
Violations return `422 { "error": "…" }` (e.g. `key-outside-allowed-dir`, `git host '…' is not in the
allowlist`). `GET …/versions` for a git-sync service returns the ref tip SHA (`{ items: [{ tag }],
source: "git" }`); the deploy shallow-clones `gitRef` and applies `gitPath`.

### `PATCH /api/services/:name`

Body is any subset of the service fields. `sourceType` cannot change; recreate the service to switch.

### `DELETE /api/services/:name`

Removes the service from hyper. **Does not delete anything in the cluster.**

### `POST /api/services/adopt`

Convenience endpoint that creates a `registry-pull` service from a cluster workload.

```json
{
  "name": "hello-world",
  "clusterId": "primary",
  "namespace": "default",
  "workloadKind": "Deployment",
  "workloadName": "hello-world",
  "containerName": "hello-world",
  "imageRef": "traefik/whoami",
  "imagePullSecret": null
}
```

## Versions, deploys, history

### `GET /api/services/:name/versions`

For `r2-bundle`:

```json
{ "items": [ { "tag": "v2026.06.28.001", "imageSize": 91234567,
               "imageKey": "...", "lastModified": "2026-06-28T00:14:09Z" } ],
  "source": "r2" }
```

For `registry-pull`:

```json
{
  "items":  [ { "tag": "v1.11.0" }, { "tag": "v1.10.4" } ],
  "source": "registry",
  "total":  95,
  "rateLimited": false,
  "authRequired": false,
  "hint":   null
}
```

`authRequired: true` indicates the registry refused anonymous access; type the tag manually.

### `POST /api/services/:name/deploy`

```json
{ "tag": "v1.10.4" }
```

The service's `deployMode` (`rolling` | `recreate` | `canary` | `blue-green`, default `rolling`,
set via `PATCH /services/:name`) controls the rollout strategy; `canary`/`blue-green` require a
registry-pull Deployment (`PATCH` returns `422 mode-workload-mismatch` otherwise).

Returns `202 { "deploymentId": 1, "accepted": true }`. The deploy is enqueued as a background
**job** and executed by the worker (serialized per service via a lock + fencing token). The
`deploymentId` is also the job id (1:1) — poll either `GET /api/deployments/:id` (legacy shape) or
`GET /api/jobs/:id` (richer).

A **degraded** service (a prior auto-rollback failed — see P1.9 below) is refused here with
`409 { "error": "service-degraded", "reason": "...", "at": "..." }`, and also refused at the worker
chokepoint and the poller, until cleared via `POST /api/services/:name/undegrade`.

### `GET /api/deployments/:id`

```json
{ "deployment": { "id": 1, "service": "hello-world", "tag": "v1.10.4",
                  "status": "done", "message": null,
                  "started_at": "2026-06-28T01:04:33.644Z",
                  "finished_at": "2026-06-28T01:04:37.448Z" } }
```

`status` is one of `pending | downloading | loading | applying | done | failed | cancelled`
(`cancelled` = a grace-window auto-rollback the operator cancelled).

### `GET /api/jobs/:id`

Richer view of the same operation (the id equals the deployment id):

```json
{ "job": { "id": 1, "kind": "deploy", "resourceKind": "service", "resourceId": "hello-world",
           "state": "running", "attempts": 1, "maxAttempts": 3,
           "nextAttemptAt": "2026-06-28T01:04:33.644Z",
           "leaseUntil": "2026-06-28T01:05:03.644Z", "leaseHolder": "worker-1",
           "lastError": null, "fencingToken": 7,
           "createdAt": "...", "updatedAt": "..." } }
```

`state` is one of `pending | running | done | failed | dead` (`failed` = handler exhausted its
retries; `dead` = the worker died repeatedly while holding it).

### `GET /api/services/:name/deployments`

Returns the last ~20 deployments (most recent first). Each row carries an `action` of
`deploy` or `rollback`.

### Custom resources (P3.1)

A read-only browser over a cluster's CustomResourceDefinitions. **Operator+** (raw cluster objects,
like Ingress YAML). The object/YAML endpoints first confirm `:resource` is a *registered CRD*, so
they can't be pointed at core resources (`secrets.`, `configmaps.`) to read their data.

- `GET /api/clusters/:id/crds` → `{ items: [{ name, group, version, kind, plural, scope, namespaced }] }` (from `kubectl get crd -o json`).
- `GET /api/clusters/:id/crds/:resource/objects?namespace=<ns>` → `{ items: [{ name, namespace, createdAt }] }`. `:resource` is `<plural>.<group>` (charset-validated, must name a real CRD); `namespace` optional (omit → all namespaces). `404` if `:resource` isn't a CRD.
- `GET /api/clusters/:id/crds/:resource/objects/:name/yaml?namespace=<ns>` → `{ yaml }` (`kubectl get <resource> <name> -o yaml -- name`). `404` if not a CRD or the object is absent.

### `GET /api/services/:name/preflight?tag=<tag>` (P3.3)

An **advisory** server-side admission dry-run for a registry-pull image bump — surfaces webhook /
policy denials (Kyverno, OPA/Gatekeeper, PodSecurity, image policies) before the operator confirms.
Operator-readable. Runs `kubectl set image … --dry-run=server` (`dryRun=All`, non-mutating).

```json
{ "applicable": true, "ok": false, "reason": "admission webhook \"validate.kyverno.svc\" denied …" }
```

`applicable` is `false` for `r2-bundle`/`git-sync` (their manifests must be materialized to dry-run —
deferred); those return `{ "applicable": false }` without touching the cluster. `ok: true` means the
dry-run passed. `400` without `tag`, `404` for an unknown service. It is advisory — the deploy is not
blocked on a failed (or unavailable) preflight.

### `GET /api/services/:name/rollback`

Previews the rollback target (registry-pull only). Resolution prefers hyper's own deployment
history (Source A: exact previous tag) and falls back to `kubectl rollout history` (Source B:
a revision number).

```json
{ "eligible": true, "previousTag": "v1.10.3", "previousRevision": null, "source": "hyper" }
```

For an `r2-bundle` service it returns `{ "eligible": false, "reason": "r2-bundle-uses-deploy-history", ... }`
(roll back by redeploying a previous tag from history instead).

### `POST /api/services/:name/rollback`

Enqueues a `rollback` job (registry-pull only; `409 { "error": "r2-bundle-uses-deploy-history" }`
otherwise, `404` if there is no previous version). Returns `202 { "jobId": 7, "accepted": true }`
— the job runs `kubectl rollout undo` under the per-service lock + fencing token. After the rollout,
`current_deployment.tag` is set to the previous tag only if the resulting pod image confirms it;
otherwise it records the actual image (or `rollback-rev-N`) and surfaces a warning in the
deployment row's `message`.

### Auto-rollback on a failed health gate (P1.9)

A registry-pull service with `autoRollback: true` (set via `PATCH /services/:name`) automatically
rolls back when a deploy fails its health gate (P1.8). On the failed gate the deploy handler enqueues
a `rollback` job (same `previousTag`/`previousRevision` resolution as above, `auto: true`) delayed by
a **10 s grace window**, then ends the deploy terminally (no retry — the image is bad). The rollback
runs with a **higher fencing token** than the failed deploy, so it wins the `current_deployment` race.

If the auto-rollback itself fails, the service is marked **degraded** (single-shot: no further
automatic action) and all deploys are refused until an operator clears it. A successful rollback
(auto or manual) clears the degraded mark.

#### `GET /api/services/:name/auto-rollback`

Reports the pending grace-window auto-rollback (if any) and the degraded state. Viewer role.

```json
{ "pending": { "id": 42, "nextAttemptAt": "2026-06-28T01:04:43.644Z" },
  "degraded": { "reason": "auto-rollback failed: ...", "at": "2026-06-28T01:04:50.000Z" } }
```

Both fields are `null` when absent. `pending` only ever reflects an **auto** rollback (a manual
`POST /rollback` is never reported here).

#### `POST /api/services/:name/auto-rollback/cancel`

Cancels the pending grace-window auto-rollback (operator's fix-forward escape hatch). Operator role.
Returns `200 { "cancelled": true, "jobId": 42 }`; `404` if nothing auto is pending; `409
{ "error": "rollback-already-running" }` if the worker already claimed it. The cancelled rollback's
deployment row is marked `cancelled`. Never cancels a manual rollback.

#### `POST /api/services/:name/undegrade`

Clears the degraded mark so deploys are allowed again. Operator role. Returns
`200 { "cleared": true }` (`false` if the service was not degraded).

## Pods, networking, logs

### `GET /api/services/:name/pods`

```json
{
  "selector": "app=hello-world",
  "items": [
    {
      "name": "hello-world-6647dcb679-khrjh",
      "namespace": "default",
      "phase": "Running",
      "podIP": "10.42.0.3",
      "podIPs": ["10.42.0.3"],
      "hostIP": "192.168.117.2",
      "nodeName": "3fdf2d1b7a87",
      "startTime": "2026-06-28T01:04:39Z",
      "containers": [
        { "name": "hello-world", "image": "traefik/whoami:v1.10.4",
          "ready": true, "restartCount": 0 }
      ]
    }
  ]
}
```

### `GET /api/services/:name/networking`

```json
{
  "service": {
    "name": "hello-world",
    "namespace": "default",
    "type": "NodePort",
    "clusterIP": "10.43.7.200",
    "clusterIPs": ["10.43.7.200"],
    "externalIPs": [],
    "ports": [
      { "name": "http", "port": 80, "targetPort": 80,
        "nodePort": 30180, "protocol": "TCP" }
    ]
  }
}
```

When no `Service` object is found in the namespace, `service` is `null` and `hint` carries the reason.

The response also includes `endpoints[]` (cluster-ip / node-port / ingress / load-balancer). Ingress
entries carry `source: { kind: "ingress", ingressName, ingressNamespace }` (for the "view source"
button) and a `dns` reachability hint: `{ resolved: true, addresses, elapsedMs }` or
`{ resolved: false, reason }` (200 ms timeout, cached 60 s).

### `GET /api/services/:name/hpa`

Returns the HPA targeting the service's workload (matched by `scaleTargetRef`), or `null`. **Gated on
the cluster's `hpaV2` capability** — `409` when absent. Viewer-readable.

```json
{ "hpa": { "name": "web", "minReplicas": 2, "maxReplicas": 10, "currentReplicas": 3,
           "desiredReplicas": 4, "targetCPUUtilizationPercentage": 50, "metricTypes": ["memory", "cpu"] } }
```

### `PATCH /api/services/:name/hpa`

Operator+. Body accepts **at most** `{ min, max, targetCPUUtilizationPercentage }` (zod `.strict()` —
any other field → `422 { "error": "unexpected_field" }`). Validates `1 ≤ min ≤ max ≤ 1000` and
`1 ≤ targetCPU ≤ 100` (cross-checked against the current bounds) → `422` on violation; `409` if the
cluster lacks `hpaV2`; `404` if no HPA targets the workload. Applies a JSON merge patch limited to
`spec.minReplicas`, `spec.maxReplicas`, and the CPU metric — **other metrics (memory/custom) are
preserved**. Returns the updated summary.

### `POST /api/services/:name/logs/token`

Mints a one-shot token for the SSE log stream (because `EventSource` cannot send an
`Authorization` header). Requires a normal auth session; it is a **viewer-level** read despite
being a POST. Returns:

```json
{ "token": "…48 hex chars…", "expiresAt": "2026-06-28T03:50:00.000Z" }
```

The token is scoped to this service, valid for 60 s, and single-use — redeeming it on the first
SSE handshake invalidates it.

### `GET /api/services/:name/logs`

Server-Sent Events stream. Authenticates via **either** a one-shot `?logToken=` (for
`EventSource`) **or** a normal cookie/bearer session (for `curl`/scripts). Query parameters:

- `logToken` *(optional)* — one-shot token from the endpoint above; required for `EventSource`
- `pod` *(required)* — pod name
- `container` *(optional)* — defaults to the service's container name
- `tail` *(optional)* — initial line count, capped at 2000 (default 200)

Event types emitted:

- `event: stdout` — one log line in `data:`
- `event: stderr` — one stderr line
- `event: heartbeat` — empty keep-alive every 15 s (ignored by the browser; defeats idle-buffering proxies)
- `event: end` — child exited; `data:` is the exit code
- `event: error` — fatal read error

Browser usage:

```js
const { token } = await (await fetch('/api/services/checkout/logs/token', {
  method: 'POST', headers: { 'X-CSRF-Token': csrf },
})).json();
const es = new EventSource(`/api/services/checkout/logs?logToken=${token}&pod=checkout-abc`);
es.addEventListener('stdout', e => console.log(e.data));
es.addEventListener('end',    e => es.close());
```

`curl` (cookie/bearer, no token needed):

```sh
curl -N -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8080/api/services/checkout/logs?pod=checkout-abc'
```

### Web terminal — `kubectl exec` (P3.2)

An interactive shell into a pod over a WebSocket. **RCE-equivalent**, so it is **operator+** to mint
and pod-ownership-checked.

- `POST /api/services/:name/exec/token` (operator+) body `{ pod, container }` → `{ token, expiresAt }`.
  One-shot, 60 s TTL, **bound to that exact (service, pod, container)**. `403` if the pod/container
  doesn't back this service; `400` on an invalid name.
- `WS /api/services/:name/exec?token=<token>` — connect a WebSocket. It self-authenticates via the
  one-shot token (a browser WS can't send an `Authorization` header — same pattern as the log token);
  the token's bound (pod, container) — not the URL — decide what runs. The server runs
  `kubectl exec -i -n <ns> <pod> -c <container> -- sh` and pipes bytes both ways (send keystrokes,
  receive shell output). The socket closes when the shell exits, on error, at a **30-minute hard
  lifetime cap**, or when the **global concurrent-session cap (16)** is exceeded at connect time.

```js
const { token } = await (await fetch('/api/services/checkout/exec/token', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
  body: JSON.stringify({ pod: 'checkout-abc', container: 'app' }),
})).json();
const ws = new WebSocket(`wss://host/api/services/checkout/exec?token=${token}`);
ws.onmessage = (e) => term.write(e.data);
term.onData((d) => ws.send(d));
```

The endpoint kills the underlying `kubectl logs -f` process when the client disconnects.

## Environment files

### Environment files — key/value rows (P1.6)

`GET /env/:kind` returns `{ path, exists, keys, rows: [{ key, description? }] }` (no values; for
`config`, `?reveal=true` adds `content`). `PUT /env/:kind/rows` takes `{ rows: [{ key, value,
description? }] }`, validates keys (empty/invalid/duplicate → `422`), strips control chars
(reported in `stripped[]`), and atomically writes. A **blank value for an existing secret key keeps
the stored secret** (server-side merge — values never round-trip). The legacy raw-content
`PUT /env/:kind` remains for one minor version (marked `deprecated`).

### `GET /api/services/:name/env/:kind`

`:kind` is `config` or `secret`.

```json
{
  "service": "hello-world",
  "kind": "config",
  "path": "/data/env/hello-world/config.env",
  "exists": true,
  "keys": ["LOG_LEVEL", "PORT"]
}
```

Add `?reveal=true` on `kind=config` to also receive the parsed contents in `content`. Secret values are never returned by the API.

### `PUT /api/services/:name/env/:kind`

Replace the file on disk.

```json
{ "content": "LOG_LEVEL=debug\nPORT=8080\n" }
```

The file is written `0644` for config and `0600` for secret, with the parent directories created on demand. Changes take effect on the next deploy.

## Integrations — machine tokens & registry webhooks (P1.10)

All management endpoints below are **admin-only**. The webhook *receiver* is the one exception (it
authenticates by its capability URL + HMAC, not a session — see below).

### Machine tokens

Long-lived, non-human bearer credentials for CI/CD. The cleartext is shown **once** at creation and
never stored — only an HMAC-SHA256 of it (keyed by the server auth secret) is kept. Tokens carry a
`role` (`operator` | `viewer`, never `admin`) and optional `serviceScope` / `clusterScope`.

- `GET /api/machine-tokens` → `{ items: [{ id, name, role, serviceScope, clusterScope, createdAt, lastUsedAt, expiresAt, revokedAt }] }` (hashes never returned).
- `POST /api/machine-tokens` body `{ name, role, serviceScope?, clusterScope?, expiresInDays? }` → `201 { token: "cht_…", machineToken: {…} }`. `token` is the cleartext, returned only here. `400` for an unknown scope target, `409` for a duplicate name, `422` for an invalid body (e.g. `role: "admin"`).
- `DELETE /api/machine-tokens/:id` → `{ revoked: true }` (`404` if unknown/already revoked). A revoked token is rejected on its next request.

Authenticate by sending `Authorization: Bearer cht_…` (same header as a human bearer — the
middleware recognizes the `cht_` prefix, looks the token up, and falls back to JWT on a miss). A
**scoped** token is confined to its service: it may call `/api/services/<serviceScope>/…` and read
its own `/api/deployments/:id` & `/api/jobs/:id`; a `clusterScope` further requires the service to
live in that cluster. Out-of-scope requests get `403 { "error": "out_of_scope" }`.

### Registry webhooks

An inbound endpoint a container registry calls on a new tag; hyper maps the pushed image to managed
registry-pull services (matched on `imageRef`, with `docker.io`/`library` defaults normalized) and
enqueues deploys.

- `GET /api/webhooks` → `{ items: [{ id, name, kind, secretId, url, createdAt, lastUsedAt, revokedAt }] }` (HMAC secrets never returned).
- `POST /api/webhooks` body `{ name, kind }` where `kind` ∈ `dockerhub | ghcr | acr | generic` → `201 { secret: "…", webhook: {…} }`. `secret` (the HMAC key) and `webhook.url` are returned only here.
- `DELETE /api/webhooks/:id` → `{ revoked: true }`.
- `POST /api/webhooks/registry/:secretId` — the **receiver** (auth carve-out). The `:secretId` is an unguessable capability; the raw body must be signed `X-Hub-Signature-256: sha256=<hex>` with HMAC-SHA256 under the webhook's secret. `404` for an unknown/revoked `secretId`, `401` for a bad/missing signature, `400` for invalid JSON. On success → `200 { deployed: [{ service, tag, deploymentId }], skipped: [{ service, tag, reason }] }` (`reason` ∈ `degraded | deploy-already-active`).

## Network discovery (P1.11)

Probe IPs/CIDRs for Kubernetes API servers and surface candidates the operator can promote into a
registered cluster. **Admin-only**, and gated by an explicit consent string so a scan is never
accidental. Every scan is logged with the operator + targets (the persistent audit row lands with
P2.1).

### `POST /api/discovery/scan`

```json
{ "targets": ["10.0.0.0/24", "192.168.1.10"], "ports": [6443], "timeoutMs": 1500,
  "consent": "scan-acknowledged" }
```

- `targets` — IPv4 addresses and/or CIDRs (expanded server-side, capped at **1024 IPs** per scan).
- `ports` — optional; defaults to `[6443, 8443, 16443]` (k3s/kubeadm, microk8s/RKE2, microk8s).
- `timeoutMs` — optional per-probe timeout (default `1500`).
- `consent` — must equal the literal `"scan-acknowledged"`, else `400 { "error": "consent-required" }`.

Each `(ip, port)` gets a TLS handshake (certificate verification skipped — we're fingerprinting) and
an anonymous `GET /version`; a response matching the apiserver shape (`major`/`minor`/`gitVersion`)
is a hit. Returns the reachable candidates:

```json
{ "candidates": [ { "ip": "10.0.0.2", "port": 6443, "reachable": true,
                    "serverVersion": "v1.31.13+k3s1", "distribution": "k3s",
                    "authMethods": ["bearer-token", "client-cert"], "ms": 8 } ],
  "ipsScanned": 256, "tuplesScanned": 256 }
```

`distribution` is inferred from `gitVersion` (`k3s` | `rke2` | `microk8s` | `k8s` | `unknown`). A bad
target or a too-large CIDR returns `400 { "error": "invalid-targets", "message": "…" }`. Promotion to
a registered cluster is a frontend convenience that prefills the Add Cluster form — hyper never
fabricates a kubeconfig.

## Setup & R2 settings

Admin-only endpoints used by the UI Setup modal to configure a fresh VM/VPS from the browser after
the binary has been installed.

### `GET /api/setup/status`

Returns registered clusters, configured service template status, and redacted R2 settings.

```json
{
  "clusters": [{ "id": "local", "name": "Local cluster", "runtime": "k3s" }],
  "services": [
    { "name": "api", "label": "api", "r2Prefix": "api/", "registered": true, "currentTag": null }
  ],
  "r2": { "endpoint": "https://...", "bucket": "service-builds", "region": "auto", "accessKeyId": "...", "secretConfigured": true }
}
```

### `GET /api/settings/r2`

Returns the current R2 config without the secret access key.

### `PUT /api/settings/r2`

Persists R2 config in SQLite `meta` and updates the in-process R2 client immediately. Leave
`secretAccessKey` blank or omitted to keep the existing secret.

```json
{ "endpoint": "https://<account>.r2.cloudflarestorage.com", "bucket": "service-builds", "region": "auto", "accessKeyId": "...", "secretAccessKey": "..." }
```

### `POST /api/settings/r2/test`

Tests either the saved R2 config (empty body) or the submitted config. Returns up to 20 top-level
prefixes from the bucket.

```json
{ "ok": true, "bucket": "service-builds", "prefixes": ["api/", "worker/"] }
```

### `GET /api/setup/services`

Returns service templates from `config.services`, including R2 prefixes and registration status.

### `POST /api/setup/bootstrap`

Registers selected services as `r2-bundle` services and optionally writes initial
`config.env` / `secret.env` files under `envFilesDir`. Existing env files are preserved unless
`overwriteEnvTemplates` is true.

```json
{ "clusterId": "local", "namespace": "default", "services": [{ "name": "api", "r2Prefix": "api/", "configEnv": "LOG_LEVEL=info\n", "secretEnv": "API_KEY=\n" }], "writeEnvTemplates": true, "overwriteEnvTemplates": false }
```

Response:

```json
{ "items": [{ "service": "api", "action": "created", "env": { "config": "created", "secret": "created" } }] }
```

## Helm release operations (P2.2)

For a service whose workload is part of a Helm release, surface the chart/version and offer a
tag-bump via `helm upgrade`. **Gated on the `helmCli` host capability** (`409` if `helm` isn't
installed). Helm-managed detection uses the workload's standard `meta.helm.sh/release-name` +
`meta.helm.sh/release-namespace` annotations — if both are absent the service isn't Helm-managed.

Per-service config (on the service, set via `PATCH /services/:name`): `helmRelease`, `helmChartRef`,
`helmImageTagValuePath` (the dotted path to the image tag in the chart's values, e.g. `image.tag` or
`app.image.tag`). All three are required to enable upgrades — **hyper never guesses `image.tag`.**

### `GET /api/services/:name/helm`

```json
{ "helm": { "release": "api", "namespace": "prod", "chart": "nginx-15.1.0", "version": "1.25.3",
            "upgradeable": true, "valuesRedacted": { "image": { "tag": "v1" }, "dbPassword": "***" } } }
```

`helm` is `null` when the workload isn't Helm-managed. `valuesRedacted` is `helm get values` with
sensitive keys masked server-side (`/password|secret|token|key$/i`, and any top-level `secrets:` /
`credentials:` block → `"***"`). `upgradeable` is true only when all three config fields are set.

### `POST /api/services/:name/helm/upgrade`

```json
{ "tag": "v2.0.0" }
```

`422 { "error": "helm-not-configured" }` if the service lacks the three config fields. Otherwise
enqueues a `helm-upgrade` job (shares the per-service lock + fencing token) and returns
`202 { "deploymentId": 1, "accepted": true }`. The job runs `helm upgrade <release> <chartRef> -n
<ns> --reuse-values --set <helmImageTagValuePath>=<tag> --wait --timeout 180s`, then **re-reads the
workload's pod template and asserts the tag took effect** — a wrong values path fails the job with
`helm-upgrade-did-not-take-effect` rather than silently doing nothing.

## Audit trail (P2.1)

Every **mutation** — HTTP or worker — appends a row to `audit_events`. HTTP mutations are recorded at
the response boundary with the final status as the outcome (so a guard denial or a validation failure
is logged as a `fail`, not silently dropped); worker job outcomes are attributed to `system`. Request
**bodies are never logged** (only method, path-derived resource, actor, and result) so secrets in
bodies don't reach the trail.

### `GET /api/audit`

Readable by any authenticated user (`viewer`+). Cursor-paginated, newest first.

Query params (all optional, ANDed): `since`, `until` (ISO timestamps; `since` inclusive, `until`
exclusive), `actor`, `action`, `resource_kind`, `result` (`ok|fail`), `page_size` (1–200, default 50),
`cursor` (the opaque `nextCursor` from the previous page).

```json
{ "items": [ { "id": 42, "ts": "2026-06-28T01:05:00.000Z", "actor": "alice", "role": "admin",
               "action": "POST /api/services/hello/deploy", "resource_kind": "services",
               "resource_id": "hello", "payload": null, "result": "ok", "message": null } ],
  "nextCursor": "2026-06-28T01:04:59.000Z|41" }
```

`nextCursor` is `null` on the last page. Pagination is keyset over `(ts, id)`, so it's stable under
concurrent inserts (no OFFSET drift).

## Generated reference (OpenAPI)

Since P0.B the HTTP layer is served by [ElysiaJS](https://elysiajs.com). The full machine-readable
contract is generated from the route definitions by `@elysiajs/openapi`:

- `GET /openapi` — interactive Scalar UI listing every route, grouped by tag (`system`, `clusters`,
  `services`, `deployments`, `service-ops`, `env`).
- `GET /openapi/json` — the OpenAPI document.

These endpoints are public in v0.1 (no auth yet); P0.4 gates them behind a read-only `viewer` role.
This hand-written reference and the generated spec describe the same surface; the contract-snapshot
tests under `src/routes/*.test.ts` keep them honest.
