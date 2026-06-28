# celeste-hyper

Self-hosted multi-cluster control plane for Kubernetes services. Lists what's running across every registered cluster, lets you adopt or manually register services, manages per-service `.env` files (projected into Kubernetes Secrets and ConfigMaps at deploy time), and rolls out new versions from either a Cloudflare R2 bundle or any container registry (ACR, GHCR, Docker Hub, Harbor, …).

Generic by design — the same single binary runs against any kubeconfig, anywhere.

Built with [Bun](https://bun.sh) → single static binary, no runtime to install. Optional Docker image for local trials.

> **Documentation is in [`docs/`](./docs/README.md)** — architecture, multi-cluster setup, service sources, local stack walkthrough, and the full HTTP API reference. Start there if you want the whole picture.

## Try it in 30 seconds

```bash
git clone <this-repo>
cd celeste-hyper
docker compose up --build
# open http://localhost:8080
```

That spins up **two k3s clusters** plus celeste-hyper, with a sample workload pre-deployed in each. Log in with the first-run `admin` / `admin` user, change the password, then click *Adopt* on either workload. See [`docs/local-stack.md`](./docs/local-stack.md) for the guided tour.

## Two image sources, one workflow

| Source type | When to use | What deploy does |
|---|---|---|
| **`r2-bundle`** | k3s on-prem, offline-friendly. Images shipped as `.tar` via R2 + manifests bundled together. | S3/R2 SDK download → `k3s ctr images import` → `kubectl apply` of bundled manifests |
| **`registry-pull`** | Cluster can pull from a registry (ACR, GHCR, etc.). Manifests already live in the cluster (you adopted an existing Deployment or created it elsewhere). | `kubectl set image <kind>/<name> <container>=<imageRef>:<tag>` + `rollout status` |

For `registry-pull` services the imagePullSecret must already exist in the namespace (`kubectl create secret docker-registry …`) — celeste-hyper just sets the image; it doesn't manage registry credentials.

## Bundle convention (for `r2-bundle`)

`celeste-hyper` expects R2 to look like:

```
s3://<bucket>/<svc>/<tag>/
  <svc>-<tag>-amd64.tar     # docker image, ready for ctr import / docker load
  k8s/
    namespace.yaml
    deployment.yaml          # template ('__IMAGE_TAG__' substituted on apply)
    deployment.rendered.yaml # optional: tag already baked-in
    service.yaml
    ...                      # any other plain YAML, applied in name order
  install.sh                 # ignored by celeste-hyper; useful for manual runs
  README.md
```

Any service can use this layout; `celeste-hyper` only depends on the bucket prefix and file convention.

`celeste-hyper` **does not** trust `configmap.example.yaml` or `secret.example.yaml` from the bundle. Instead it reads `config.env` and `secret.env` from the VM filesystem at `/etc/celeste-hyper/services/<svc>/` and applies them as `<svc>-config` ConfigMap and `<svc>-secret` Secret — so secrets never live in git.

## Cluster discovery (automatic)

On startup and every `poller.intervalSec` seconds, celeste-hyper runs `kubectl get deployments,statefulsets,daemonsets -A -o json` and surfaces:

- **Managed services**: the ones the UI knows about. Each card shows current tag, source type, namespace, `config.env` keys, `secret.env` keys, cluster-side replica health, and any "new version available" hint from R2 polling.
- **Detected (unmanaged)**: workloads in the cluster that aren't registered yet. Click **Adopt** to register one as a `registry-pull` service in one click — the form pre-fills with the workload's existing image and container name.

There is no manual "scan" button. The header shows the last scan timestamp.

**kubectl version.** Minimum supported `kubectl` is **1.30** (matches the k3s 1.31 API surface). On boot celeste-hyper probes the client version and logs a warning if it's below the minimum; per cluster it compares the client against the apiserver version (`kubectl version -o json`) and the cluster card shows a "version skew" pill when they're more than ±1 minor apart (the Kubernetes version-skew policy).

## Adding a service manually

The **+ adicionar serviço** button in the UI opens a form. Pick a source type:

- **R2 bundle**: name + namespace + r2Prefix (must end with `/`).
- **Registry pull**: name + namespace + imageRef (e.g. `myacr.azurecr.io/myapp`, *without* tag) + optional workloadKind/workloadName/containerName/imagePullSecret.

Equivalent REST:

```bash
curl -X POST http://hyper/api/services \
  -H 'Content-Type: application/json' \
  -d '{ "sourceType": "registry-pull",
        "name": "my-app",
        "namespace": "default",
        "imageRef": "myacr.azurecr.io/my-app",
        "imagePullSecret": "acr-pull" }'
```

## Quick start (on the k3s VM)

### One-liner (recommended)

Paste this on any Debian/Ubuntu/RHEL/Alpine host with internet access — it installs Bun + kubectl, clones the repo, builds the binary, drops the systemd unit, and starts the service. Re-run the same command to pull the latest `main` and roll out the new build in place; existing config and state are preserved.

```bash
curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/bootstrap.sh | sudo bash
```

Common overrides:

```bash
# pin a branch / tag / sha
curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/bootstrap.sh | sudo REF=v0.1.0 bash

# also install k3s on this host
curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/bootstrap.sh | sudo INSTALL_CLUSTER=true CLUSTER_MODE=k3s bash

# seed R2 credentials on first install
curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/bootstrap.sh | sudo \
  R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com \
  R2_BUCKET=service-builds \
  R2_ACCESS_KEY_ID=<key> R2_SECRET_ACCESS_KEY=<secret> bash
```

All tunables (`REPO_URL`, `REF`, `SRC_DIR`, `PREFIX`, `CONFIG_DIR`, `STATE_DIR`, `BUN_VERSION`, `TARGET_ARCH`, `FORCE_REBUILD`, `SKIP_BUILD`, `INSTALL_KUBECTL`, `INSTALL_CLUSTER`, `CLUSTER_MODE`) are documented at the top of [`deploy/bootstrap.sh`](./deploy/bootstrap.sh).

### Manual install (pre-built binary)

1. Copy the binary and deploy assets to the VM:

   ```bash
   scp build/celeste-hyper-linux-x64 deploy/celeste-hyper.service \
       deploy/install.sh config.example.json README.md \
       root@vm:/tmp/celeste-hyper-install/
   ```

2. Install + enable:

   ```bash
   ssh root@vm
   cd /tmp/celeste-hyper-install
   sudo BINARY=./celeste-hyper-linux-x64 ./install.sh
   ```

3. Edit `/etc/celeste-hyper/config.json` with the real R2 endpoint, bucket and credentials. Restart:

   ```bash
   sudo systemctl restart celeste-hyper
   journalctl -u celeste-hyper -f
   ```

4. Drop env files (root-only, 0600) under `/etc/celeste-hyper/services/<svc>/`:

   ```
   /etc/celeste-hyper/services/my-service/config.env
   /etc/celeste-hyper/services/my-service/secret.env
   ```

   These can also be edited from the UI later — files are created with the right permissions automatically.

5. Open `http://<vm>:8080` in the browser. List services, pick a version, hit deploy.

## Try it in a container (no VM needed)

```bash
docker build -t celeste-hyper:dev .
docker run --rm -d --name celeste-hyper-dev -p 8080:8080 \
  -e R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com \
  -e R2_BUCKET=<bucket> \
  -e R2_ACCESS_KEY_ID=<key> \
  -e R2_SECRET_ACCESS_KEY=<secret> \
  celeste-hyper:dev
```

The container ships with a baseline `config.docker.json` and an empty service registry. The UI loads at http://localhost:8080. Cluster discovery and deploy will fail without reachable kubeconfigs and container runtime tooling — that's expected for a UI-only demo.

## Config

`/etc/celeste-hyper/config.json` — see `config.example.json` for the full schema.

Hot fields you'll touch:

- `r2.{endpoint,bucket,accessKeyId,secretAccessKey}` — Cloudflare R2 credentials (or any S3-compatible)
- `k8s.runtime` — `auto` (detects k3s → docker → containerd), or pin explicitly
- `poller.autoDeploy` — when `true`, every new version found in R2 is deployed immediately. When `false`, the poller only discovers and the UI surfaces "new version available".
- `services[]` — seeds the registry on first boot only. After that, the registry lives in SQLite and is edited through the UI / API. Editing `services[]` later does **not** retroactively update existing rows.

Env-var overrides (for ops / secrets injection):

- `R2_ENDPOINT_URL`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- `HYPER_LISTEN_PORT`, `HYPER_STATE_DIR`, `HYPER_ENV_FILES_DIR`
- `HYPER_CONFIG` — path to the JSON config file
- `LOG_LEVEL` — `debug|info|warn|error`
- `LOG_FORMAT` — `json` (default, machine-parseable) or `pretty` (human-readable). Also settable as `--log-format=pretty` on the server command; the flag wins over the env.

## What a deploy does

### R2 bundle

1. List `s3://<bucket>/<svc>/<tag>/` and download the bundle into `<workDir>/<svc>/<tag>/`.
2. `k3s ctr images import` (or `docker load` / `ctr import`, per runtime) the `.tar`.
3. Apply `k8s/namespace.yaml` if present.
4. Read `/etc/celeste-hyper/services/<svc>/config.env` → `kubectl create configmap <svc>-config --from-env-file=... --dry-run=client -o yaml | kubectl apply -f -` (skipped if file absent).
5. Same for `secret.env` → `<svc>-secret`.
6. Apply `k8s/deployment.rendered.yaml` if present, otherwise `k8s/deployment.yaml` with `__IMAGE_TAG__` substituted by the tag being deployed.
7. Apply every other `*.yaml` in `k8s/` (service, ingress, etc.) — filename-sorted; idempotent thanks to `kubectl apply`.
8. Record `current_deployment` and append a row to `deployments` for the UI history.

### Registry pull

1. `kubectl set image <kind>/<workloadName> <containerName>=<imageRef>:<tag>` in the configured namespace.
2. `kubectl rollout status …` with a 180s timeout.
3. Record the current tag + history row.

For `config.env` / `secret.env` to be applied to a `registry-pull` service, the workload's manifest must already reference `<svc>-config` and `<svc>-secret`. Editing env files in the UI persists them on disk; they are applied as Kubernetes resources only on the next deploy.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/system` | runtime, kubeconfig path, poller status, R2 endpoint/bucket |
| GET | `/api/services` | managed services + unmanaged cluster workloads + last scan timestamp |
| GET | `/api/services/:name` | service detail |
| POST | `/api/services` | create a service (body matches `r2-bundle` or `registry-pull` schema) |
| PATCH | `/api/services/:name` | update a service (sourceType is immutable; recreate to change) |
| DELETE | `/api/services/:name` | unregister from celeste-hyper (doesn't touch cluster resources) |
| POST | `/api/services/adopt` | adopt an unmanaged cluster workload as a `registry-pull` service |
| GET | `/api/services/:name/versions` | versions available in R2 (empty for registry-pull) |
| GET | `/api/services/:name/deployments` | recent deploy attempts |
| POST | `/api/services/:name/deploy` | `{ "tag": "v..." }` → trigger deploy |
| GET | `/api/services/:name/env/:kind` | `kind` is `config`\|`secret`; returns parsed keys (and value for `config?reveal=true`) |
| PUT | `/api/services/:name/env/:kind` | `{ "content": "..." }` writes the dotenv file |

## UI

- The production binary serves an embedded Vite/React frontend generated from `frontend/`.
- Theme toggle (top-right): light by default, dark via the dot button. Persisted in localStorage.
- Cards show: source type pill, cluster health pill, current tag, new-version pill (when one is detected), and a side-by-side block listing the keys present in `config.env` / `secret.env`.
- Unmanaged section shows workloads detected in the cluster but not registered here — adopting them is a single click.
- Auto-refreshes every 8 seconds.

## Build

Local dev (macOS / Linux host):

```bash
bun install
bun run dev          # backend watch mode
bun run frontend:dev # Vite dev server in a second terminal
bun run typecheck
```

Compile a standalone binary:

```bash
bun run build              # host platform
bun run build:linux-x64    # for the k3s VM (most common)
bun run build:linux-arm64
bun run build:all
```

Output lives in `build/`. The Linux binary is ~92 MB and bundles Bun + every dependency — no `node_modules` needed on the VM.
The Vite build is embedded into the binary during `bun run build`; `frontend/dist` is only an intermediate local artifact.

## Auth

Every `/api/*` route requires authentication except `/api/health`, `/api/login`, and `/api/version`. Sessions are HS256 JWTs issued as an `HttpOnly` cookie; CLI/automation can also send the same token as `Authorization: Bearer <jwt>`. Mutating cookie-authenticated requests must include the CSRF token returned by `GET /api/me`.

On first boot with no users, celeste-hyper creates a temporary `admin` / `admin` user with `mustChangePassword=true`. Log in once and change it immediately. Set `HYPER_JWT_SECRET` to a stable secret with at least 32 characters when you need explicit rotation or multiple replicas; otherwise a random secret is generated once and persisted in SQLite.

Run the UI behind TLS (reverse proxy, VPN, or Cloudflare Tunnel). Built-in auth protects the app; network-level access control is still recommended for Kubernetes operators.

## Limits / future work

- Polling cadence is global, not per-service.
- `registry-pull` tag listing is best-effort: public registries usually work through the OCI distribution API; private registries may return `authRequired`, in which case type the tag manually.
- Deploys, rollbacks, Helm upgrades, and webhook-triggered deployments run as background jobs with per-service locking and fencing.
- Registry-pull services support manual rollback via `kubectl rollout undo`; R2-bundle rollback is done by redeploying a previous bundle tag.
- UI is a Vite/React app embedded into the Bun binary at build time.
