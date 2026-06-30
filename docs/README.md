# Celeste Hyper — Documentation

Celeste Hyper is a self-hosted control plane for Kubernetes services whose images are distributed via Cloudflare R2 (or any S3-compatible object store) **or pulled from a container registry** (ACR, GHCR, Docker Hub, Harbor). It manages one or many clusters from a single binary, surfaces per-service environment files, streams live pod logs, and performs deploys in the background.

A single binary, written with [Bun](https://bun.sh), with a built-in HTTP API and an embedded Vite UI — no external runtime, no separate frontend bundle in production.

## Where to start

| If you want to… | Read |
|---|---|
| Get the big picture | [Architecture](./architecture.md) |
| Run two clusters locally and click around | [Local stack walkthrough](./local-stack.md) |
| Develop the Vite UI and package it into the binary | [Frontend workflow](./frontend.md) |
| Add a real production cluster | [Clusters & kubeconfig](./clusters.md) |
| Understand `r2-bundle` vs `registry-pull` | [Service sources](./sources.md) |
| Set up a CI pipeline that ships builds to R2 for hyper to deploy | [Cloudflare R2 for deployments](./cloudflare-r2-deployments/README.md) |
| Wire something against the HTTP API | [API reference](./api.md) |
| Operate the host (migrations, backups, auth) | [Operations runbook](./operations.md) |

## System design at a glance

```mermaid
flowchart LR
  subgraph Devs["Developer workflow"]
    Push["git push → main"]
    GHA["GitHub Actions: build-image"]
  end

  subgraph Distribution
    R2[("Cloudflare R2<br/>(or any S3-compatible)")]
    Registry[("Container registry<br/>ACR / GHCR / Docker Hub")]
  end

  subgraph Hyper["celeste-hyper host"]
    direction TB
    Bin["Bun binary<br/>(HTTP + UI + SQLite)"]
    Env["/etc/celeste-hyper/services/&lt;svc&gt;/<br/>config.env · secret.env"]
    Cfg["/etc/celeste-hyper/config.json"]
    State["state.sqlite<br/>clusters · services · deployments"]
    Bin --- Env
    Bin --- Cfg
    Bin --- State
  end

  subgraph Clusters["Kubernetes clusters"]
    direction TB
    K1["Cluster A<br/>(primary)"]
    K2["Cluster B<br/>(edge / staging / regional)"]
    Kn["…"]
  end

  Push --> GHA
  GHA --> R2
  GHA -. or pushes manifests .-> Registry
  R2 -- S3/R2 SDK downloads .tar + manifests --> Bin
  Registry -. image pulled by kubelet on deploy .-> K1
  Registry -. image pulled by kubelet on deploy .-> K2
  Bin -- kubectl apply / set image --> K1
  Bin -- kubectl apply / set image --> K2
  Bin -- kubectl ctr import .tar --> K1
  K1 --- Kn
```

## Two distribution models, one workflow

```mermaid
flowchart TB
  subgraph r2["r2-bundle (offline-friendly)"]
    A1[".tar image bundled<br/>with k8s manifests in R2"]
    A2["hyper downloads bundle"]
    A3["k3s ctr import .tar"]
    A4["kubectl apply manifests"]
    A1 --> A2 --> A3 --> A4
  end
  subgraph reg["registry-pull (cloud-native)"]
    B1["Image already in registry"]
    B2["hyper runs<br/>kubectl set image"]
    B3["Cluster pulls image"]
    B1 --> B2 --> B3
  end
```

`r2-bundle` is ideal for k3s on-prem nodes that can't (or shouldn't) pull from a public registry. `registry-pull` is ideal when the cluster has registry credentials and the image is already published. The same control plane handles both side by side — see [Service sources](./sources.md) for full details.

## High-level flow when you click *Deploy*

```mermaid
sequenceDiagram
  participant U as User (UI)
  participant H as celeste-hyper
  participant DB as SQLite (state)
  participant R as R2 / Registry
  participant K as Target cluster

  U->>H: POST /services/:name/deploy {tag}
  H->>DB: insert deployment row (pending)
  H-->>U: 202 { deploymentId }
  Note over H: deploy runs in background

  alt r2-bundle
    H->>R: list & download bundle
    H->>K: k3s ctr import <.tar>
    H->>K: kubectl apply -f manifests/
  else registry-pull
    H->>K: kubectl set image kind/name
    H->>K: kubectl rollout status
  end

  H->>DB: update status (done | failed)
  U->>H: GET /deployments/:id (polled every 1.5s)
  H-->>U: current status + steps
```

## What lives where on disk

```mermaid
flowchart LR
  subgraph host["Hyper host (Linux VM)"]
    direction TB
    bin["/opt/celeste-hyper/bin/celeste-hyper"]
    unit["/etc/systemd/system/celeste-hyper.service"]
    cfg["/etc/celeste-hyper/config.json"]
    kc["/etc/celeste-hyper/clusters/&lt;id&gt;.kubeconfig"]
    env["/etc/celeste-hyper/services/&lt;svc&gt;/{config,secret}.env"]
    state["/var/lib/celeste-hyper/state.sqlite"]
    work["/var/lib/celeste-hyper/work/&lt;cluster&gt;/&lt;svc&gt;/&lt;tag&gt;/"]
  end
```

All paths are configurable; the defaults above match the systemd unit shipped in `deploy/`. Secrets never leave the host: `secret.env` files stay on disk (0600, root-only) and are projected into the cluster as Kubernetes `Secret` resources at deploy time.

## Multi-cluster posture

A single hyper instance can manage many clusters. The model is intentionally simple:

```mermaid
classDiagram
  class Cluster {
    +id: string (immutable)
    +name: string
    +kubeconfigPath: string
    +defaultNamespace: string
    +runtime: auto | k3s | docker | containerd
    +enabled: bool
  }
  class Service {
    +name: string (unique)
    +clusterId: string
    +namespace: string
    +sourceType: r2-bundle | registry-pull
  }
  Cluster "1" --> "*" Service : owns
```

Each service belongs to exactly one cluster. A service named the same thing in two clusters is two separate registry entries (e.g. `payments-prod` and `payments-staging`). For details and the recommended kubeconfig handling for LAN vs WAN clusters, see [Clusters & kubeconfig](./clusters.md).

## Where the rest of the docs go

- **[Architecture](./architecture.md)** — internal modules, data flow, why each design choice
- **[Frontend workflow](./frontend.md)** — running backend and Vite separately in development, then embedding the UI into the production binary
- **[Clusters & kubeconfig](./clusters.md)** — adding clusters, kubeconfig hygiene, on-prem vs cloud, health checks
- **[Service sources](./sources.md)** — choosing between `r2-bundle` and `registry-pull`, bundle layout, image-tag listing
- **[Cloudflare R2 for deployments](./cloudflare-r2-deployments/README.md)** — the producer side: a platform-agnostic GitHub Actions template that builds, bundles, and ships to R2 for an `r2-bundle` deployer to pick up
- **[Local stack walkthrough](./local-stack.md)** — running the two-cluster demo via Docker Compose
- **[API reference](./api.md)** — every REST endpoint, request and response schemas
- **[Operations runbook](./operations.md)** — schema migrations, backups, first-run auth, the `bun run check` gate

If you only have time for one document, read **[Architecture](./architecture.md)** — it covers the moving parts and links out to the rest.
