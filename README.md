# celeste-hyper

Self-hosted multi-cluster control plane for Kubernetes. Single Bun binary, embedded UI, no external runtime.

## Install

On any Debian/Ubuntu/RHEL/Alpine host:

```bash
curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/bootstrap.sh | sudo bash
```

Idempotent — re-run the same command to pull the latest `main` and roll out the new build in place. Existing `/etc/celeste-hyper/config.json` and `/var/lib/celeste-hyper/state.sqlite` are preserved.

## Update

```bash
sudo /opt/celeste-hyper/source/deploy/update.sh
```

The script is idempotent and **does not touch** `/etc/celeste-hyper/config.json`,
the env files, or the cluster's running workloads. It runs `--version` on
the new binary as a pre-flight, snapshots `state.sqlite` to
`state.sqlite.pre-update.<ts>`, atomically swaps the binary, and rolls
back automatically if the API does not answer within 60 s of the restart.

Common variants:

```bash
# pin a ref (branch / tag / sha)
sudo /opt/celeste-hyper/source/deploy/update.sh --ref v0.2.0

# install a prebuilt binary you uploaded out-of-band
sudo /opt/celeste-hyper/source/deploy/update.sh --binary /tmp/celeste-hyper-linux-x64

# dry-run: build + verify but don't install
sudo /opt/celeste-hyper/source/deploy/update.sh --check

# undo the last update
sudo /opt/celeste-hyper/source/deploy/update.sh --rollback
```


## Fleet — add more machines (master + workers)

Turn a second machine on the same LAN into a managed cluster without the manual kubeconfig dance.
On the **master**, mint a one-shot enrollment token (UI: the *Add machine* button, admin only — or
`POST /api/enrollment-tokens`). It prints a paste-ready command; run it as root on the **worker**:

```bash
curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/join.sh \
  | sudo MASTER_URL=https://master.lan:8080 ENROLL_TOKEN=che_xxxxx bash
```

`join.sh` installs single-node k3s, pins the API-server certificate to the worker's LAN IP, rewrites
the kubeconfig, and self-registers with the master over `/api/enroll`. The worker then shows up as a
cluster you can deploy to. Enrolled clusters default to `imageLoad: remote-pull`, so **`r2-bundle`
deploys land the image on the *worker's* node** (via a one-shot in-cluster import Job) and
`registry-pull` (ACR/GHCR/…) works as usual — both from the master. Enrollment tokens are single-use,
short-lived (default 30 min), and HMAC-stored. Prefer HTTPS (reverse proxy / VPN) outside a trusted
LAN. See [`docs/clusters.md`](./docs/clusters.md#fleet-enrollment-p4) for the full flow, and
`./scripts/fleet-sim.sh` for a container-based end-to-end demo (master + two workers + an NGINX deploy).

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

All tunables are documented at the top of [`deploy/bootstrap.sh`](./deploy/bootstrap.sh). For a manual install from a pre-built binary, see [`docs/operations.md`](./docs/operations.md).

After the install completes, open `http://<host>:8080` and log in with the bootstrap `admin` / `admin` user — you'll be forced to change the password before doing anything else.

## Try it locally

```bash
git clone https://github.com/Celeste-inc/celeste-hyper.git
cd celeste-hyper
docker compose up --build
# open http://localhost:8080
```

Spins up two k3s clusters plus celeste-hyper with sample workloads pre-deployed. See [`docs/local-stack.md`](./docs/local-stack.md) for the guided tour.

## What it does

Lists every workload across every registered cluster, adopts existing ones with one click, manages per-service `config.env` / `secret.env` files (projected as Kubernetes `ConfigMap` and `Secret` at deploy time), and rolls out new versions from either Cloudflare R2 (`r2-bundle`, offline-friendly) or any container registry (`registry-pull`: ACR, GHCR, Docker Hub, Harbor, …). Generic by design — the same single binary runs against any kubeconfig, anywhere.

## Documentation

The full documentation lives in [`docs/`](./docs/README.md):

| Topic | Link |
|---|---|
| Big-picture architecture | [`docs/architecture.md`](./docs/architecture.md) |
| Local stack walkthrough  | [`docs/local-stack.md`](./docs/local-stack.md) |
| Clusters & kubeconfig    | [`docs/clusters.md`](./docs/clusters.md) |
| Service sources          | [`docs/sources.md`](./docs/sources.md) |
| Frontend workflow        | [`docs/frontend.md`](./docs/frontend.md) |
| HTTP API reference       | [`docs/api.md`](./docs/api.md) |
| Operations runbook       | [`docs/operations.md`](./docs/operations.md) |

## License

[MIT](./LICENSE)
