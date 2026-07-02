#!/usr/bin/env bash
# Fleet R2-bundle end-to-end (P4.3): deploy an r2-bundle service from the master onto a REMOTE
# enrolled cluster, proving the in-cluster import Job loads the image on the worker's node.
#
# MinIO stands in for Cloudflare R2. A bundle (image tar + k8s manifests) is uploaded to it; a worker
# is enrolled as a `remote-pull` cluster; the master deploys the bundle; we verify the pod runs with
# imagePullPolicy:Never (which can only succeed if the image was loaded onto the worker's containerd).
#
#   ./scripts/fleet-r2-sim.sh            # build, run, verify
#   ./scripts/fleet-r2-sim.sh --down     # tear down (and volumes)
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f compose.fleet.yaml)
BASE="http://localhost:8088"
MINIO="http://localhost:9000"
BUCKET="fleet-bundles"
JAR="$(mktemp)"; CSRF=""; ADMIN_PW="fleet-admin-pw-1"
CID="edge-a"; WORKER="worker-a"; SVC="r2demo"; NS="r2demo"; TAG="v1"
IMAGE_REF="registry.local/celeste-r2-demo:${TAG}"   # registry-qualified → no docker.io normalization ambiguity
BUNDLE="$(mktemp -d)"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
trap 'rm -f "$JAR"; rm -rf "$BUNDLE"' EXIT

if [ "${1:-}" = "--down" ]; then "${COMPOSE[@]}" down -v; exit 0; fi
command -v jq >/dev/null 2>&1 || die "need jq on the host"
command -v docker >/dev/null 2>&1 || die "need docker on the host"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE$path" -b "$JAR" -c "$JAR" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" --data "$body"
  else
    curl -sS -X "$method" "$BASE$path" -b "$JAR" -c "$JAR" -H "X-CSRF-Token: $CSRF"
  fi
}

log "building + starting the fleet (master + minio + $WORKER)"
"${COMPOSE[@]}" up -d --build master minio "$WORKER"

log "waiting for master + minio"
for i in $(seq 1 60); do curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break; [ "$i" = 60 ] && die "master down"; sleep 2; done
for i in $(seq 1 60); do curl -fsS "$MINIO/minio/health/live" >/dev/null 2>&1 && break; [ "$i" = 60 ] && die "minio down"; sleep 2; done
ok "master + minio up"

log "building the r2 bundle (image tar + manifests)"
# Build a COMPLETE single-arch OCI archive with skopeo. `docker save` on a containerd-image-store
# Docker emits an incomplete multi-arch archive whose referenced blobs aren't all present, so
# `ctr images import` fails "content digest … not found" — skopeo's oci-archive is self-contained.
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64|amd64) ARCH=amd64 ;; *) ARCH=amd64 ;; esac
docker run --rm -v "$BUNDLE:/out" quay.io/skopeo/stable copy --override-arch "$ARCH" --override-os linux \
  docker://docker.io/traefik/whoami:v1.10.4 "oci-archive:/out/image.tar:${IMAGE_REF}" >/dev/null 2>&1
mkdir -p "$BUNDLE/k8s"
cat > "$BUNDLE/k8s/namespace.yaml" <<EOF
apiVersion: v1
kind: Namespace
metadata: { name: ${NS} }
EOF
cat > "$BUNDLE/k8s/deployment.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${SVC}
  namespace: ${NS}
  labels: { app: ${SVC} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${SVC} } }
  template:
    metadata: { labels: { app: ${SVC} } }
    spec:
      containers:
        - name: ${SVC}
          image: ${IMAGE_REF}
          imagePullPolicy: Never
          ports: [{ containerPort: 80 }]
EOF
ok "bundle built ($(du -h "$BUNDLE/image.tar" | cut -f1))"

log "seeding MinIO ($BUCKET) with demo/$TAG/"
R2_ACCESS_KEY_ID=fleetadmin R2_SECRET_ACCESS_KEY=fleetadmin123 \
  bun scripts/r2-seed.ts "$MINIO" "$BUCKET" "$BUNDLE" "demo/${TAG}/"
ok "bundle uploaded"

log "authenticating"
curl -sS -X POST "$BASE/api/login" -c "$JAR" -H "Content-Type: application/json" --data '{"username":"admin","password":"admin"}' >/dev/null
CSRF="$(api GET /api/me | jq -r '.csrfToken')"
api POST /api/change-password "{\"currentPassword\":\"admin\",\"newPassword\":\"$ADMIN_PW\"}" >/dev/null
curl -sS -X POST "$BASE/api/login" -c "$JAR" -H "Content-Type: application/json" --data "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" >/dev/null
CSRF="$(api GET /api/me | jq -r '.csrfToken')"
[ -n "$CSRF" ] && [ "$CSRF" != "null" ] || die "auth failed"
ok "authenticated"

log "enrolling $WORKER as remote-pull cluster '$CID'"
TOK="$(api POST /api/enrollment-tokens "{\"name\":\"$CID\",\"clusterId\":\"$CID\",\"clusterName\":\"$CID\",\"runtime\":\"k3s\",\"imageLoad\":\"remote-pull\",\"expiresInMinutes\":60}" | jq -r '.token')"
[ -n "$TOK" ] && [ "$TOK" != "null" ] || die "mint failed"
"${COMPOSE[@]}" exec -T \
  -e MASTER_URL="http://master:8080" -e ENROLL_TOKEN="$TOK" -e ADVERTISE_IP="$WORKER" -e NODE_NAME="$WORKER" \
  -e K3S_EXTRA="--snapshotter=native --disable=traefik --disable=metrics-server --disable=servicelb" \
  "$WORKER" bash -c 'echo $$ > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; exec bash /repo/deploy/join.sh'
for i in $(seq 1 40); do
  [ "$(api GET /api/clusters | jq -r "[.items[]|select(.id==\"$CID\" and .health.ok==true)]|length")" = "1" ] && break
  [ "$i" = 40 ] && die "cluster $CID not healthy"; sleep 3
done
ok "cluster '$CID' healthy (remote-pull)"

log "registering the r2-bundle service"
api POST /api/services "{\"sourceType\":\"r2-bundle\",\"name\":\"$SVC\",\"namespace\":\"$NS\",\"clusterId\":\"$CID\",\"r2Prefix\":\"demo/\",\"manifestRoot\":\"k8s\",\"imageTarPattern\":\"image.tar\",\"enabled\":true}" | jq -c '.service // .' >/dev/null
ok "service registered"

log "deploying $SVC:$TAG from the master onto $CID (r2-bundle → remote import Job)"
DID="$(api POST "/api/services/$SVC/deploy" "{\"tag\":\"$TAG\"}" | jq -r '.deploymentId')"
[ -n "$DID" ] && [ "$DID" != "null" ] || die "deploy not accepted"
log "deployment id=$DID; polling…"
STATUS=""
for i in $(seq 1 90); do
  body="$(api GET "/api/deployments/$DID")"
  STATUS="$(printf '%s' "$body" | jq -r '.deployment.status')"
  echo "  [$((i*4))s] status=$STATUS"
  case "$STATUS" in
    done) ok "deploy status=done"; break ;;
    failed) printf '%s\n' "$body" | jq -r '.deployment.message'; break ;;
  esac
  [ "$i" = 90 ] && { echo "timeout"; break; }
  sleep 4
done

log "verifying image landed on the worker's node + pod is Running"
echo "--- images on the node (should include $IMAGE_REF) ---"
"${COMPOSE[@]}" exec -T "$WORKER" k3s ctr -n k8s.io images ls 2>/dev/null | grep -i "celeste-r2-demo" || echo "  (image not found on node)"
echo "--- import Jobs ---"
"${COMPOSE[@]}" exec -T "$WORKER" k3s kubectl -n "$NS" get jobs 2>/dev/null || true

if "${COMPOSE[@]}" exec -T "$WORKER" k3s kubectl -n "$NS" rollout status deploy/"$SVC" --timeout=120s 2>/dev/null; then
  pods="$("${COMPOSE[@]}" exec -T "$WORKER" k3s kubectl -n "$NS" get pods -l app="$SVC" --no-headers 2>/dev/null)"
  printf '%s\n' "$pods"
  printf '%s' "$pods" | grep -q "Running" || die "pod not Running"
  echo
  ok "R2-BUNDLE E2E PASSED — image loaded on remote worker via import Job; $SVC Running on $CID"
  echo "   Tear down: ./scripts/fleet-r2-sim.sh --down"
else
  echo "--- pod describe (diagnostics) ---"
  "${COMPOSE[@]}" exec -T "$WORKER" k3s kubectl -n "$NS" describe pods -l app="$SVC" 2>/dev/null | tail -30 || true
  die "rollout failed on $WORKER"
fi
