#!/usr/bin/env bash
# Fleet end-to-end simulation driver (P4).
#
# Brings up a master + two Debian "client cluster" machines, enrolls each via deploy/join.sh
# (real k3s install + self-registration with a one-shot token), then deploys NGINX from the master
# onto a worker and verifies it runs. Proves the whole master/worker story end to end.
#
#   ./scripts/fleet-sim.sh           # build, run, verify (leaves the stack up)
#   ./scripts/fleet-sim.sh --down    # tear the stack down (and volumes)
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f compose.fleet.yaml)
BASE="http://localhost:8088"
JAR="$(mktemp)"
CSRF=""
ADMIN_PW="fleet-admin-pw-1"
NS="demo"
APP="nginx-demo"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
trap 'rm -f "$JAR"' EXIT

if [ "${1:-}" = "--down" ]; then "${COMPOSE[@]}" down -v; exit 0; fi

command -v jq >/dev/null 2>&1 || die "need jq on the host to parse JSON (brew install jq)"
jget() { jq -r "$1"; }

# Authenticated API call: api METHOD PATH [JSON_BODY]
api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE$path" -b "$JAR" -c "$JAR" \
      -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" --data "$body"
  else
    curl -sS -X "$method" "$BASE$path" -b "$JAR" -c "$JAR" -H "X-CSRF-Token: $CSRF"
  fi
}

log "building + starting the fleet (master + worker-a + worker-b)"
"${COMPOSE[@]}" up -d --build

log "waiting for the master API"
for i in $(seq 1 60); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && die "master did not come up"
  sleep 2
done
ok "master is up at $BASE"

log "authenticating (admin/admin → forced password change)"
curl -sS -X POST "$BASE/api/login" -c "$JAR" -H "Content-Type: application/json" \
  --data '{"username":"admin","password":"admin"}' >/dev/null
CSRF="$(api GET /api/me | jget '.csrfToken')"
api POST /api/change-password "{\"currentPassword\":\"admin\",\"newPassword\":\"$ADMIN_PW\"}" >/dev/null
# Re-login with the new password (the change rotated the session intent).
curl -sS -X POST "$BASE/api/login" -c "$JAR" -H "Content-Type: application/json" \
  --data "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" >/dev/null
CSRF="$(api GET /api/me | jget '.csrfToken')"
[ -n "$CSRF" ] && [ "$CSRF" != "null" ] || die "could not authenticate to the master"
ok "authenticated as admin"

# Enroll one worker: mint a token, then run the REAL join.sh inside that worker container.
enroll() {
  local worker="$1" cid="$2"
  log "minting enrollment token for $cid"
  local resp tok
  resp="$(api POST /api/enrollment-tokens "{\"name\":\"$cid\",\"clusterId\":\"$cid\",\"clusterName\":\"$cid\",\"runtime\":\"k3s\",\"imageLoad\":\"remote-pull\",\"expiresInMinutes\":60}")"
  tok="$(printf '%s' "$resp" | jget '.token')"
  [ -n "$tok" ] && [ "$tok" != "null" ] || die "mint failed for $cid: $resp"
  log "running join.sh on $worker (installs k3s + enrolls) — this takes a couple of minutes"
  # Run join.sh from inside the cgroup leaf (so the k3s it starts lands there, leaving the cgroup
  # root empty — required for kubelet to create /sys/fs/cgroup/kubepods on cgroup v2).
  "${COMPOSE[@]}" exec -T \
    -e MASTER_URL="http://master:8080" \
    -e ENROLL_TOKEN="$tok" \
    -e ADVERTISE_IP="$worker" \
    -e NODE_NAME="$worker" \
    -e K3S_EXTRA="--snapshotter=native --disable=traefik --disable=metrics-server --disable=servicelb" \
    "$worker" bash -c 'echo $$ > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; exec bash /repo/deploy/join.sh'
  ok "$worker enrolled as cluster '$cid'"
}

enroll worker-a edge-a
enroll worker-b edge-b

log "waiting for both clusters to report healthy on the master"
for i in $(seq 1 60); do
  reachable="$(api GET /api/clusters | jget '[.items[]|select(.health.ok==true)]|length')"
  [ "${reachable:-0}" -ge 2 ] && break
  [ "$i" = 60 ] && die "clusters did not become healthy (got ${reachable:-0}/2)"
  sleep 3
done
ok "both clusters healthy"
api GET /api/clusters | jget '.items[]|"\(.id) origin=\(.origin) imageLoad=\(.imageLoad) health=\(.health.ok)"' || true

log "deploying NGINX from the master onto edge-a"
dep="$(api POST /api/templates/deploy "{\"templateId\":\"nginx\",\"name\":\"$APP\",\"namespace\":\"$NS\",\"clusterId\":\"edge-a\",\"replicas\":1,\"serviceType\":\"NodePort\"}")"
printf '%s\n' "$dep" | grep -qiE 'error' && die "template deploy rejected: $dep"
ok "deploy accepted"

log "verifying NGINX is Running on worker-a (the remote machine)"
if "${COMPOSE[@]}" exec -T worker-a k3s kubectl -n "$NS" rollout status deploy/"$APP" --timeout=180s; then
  ok "rollout complete on worker-a"
else
  "${COMPOSE[@]}" exec -T worker-a k3s kubectl -n "$NS" get pods -o wide || true
  die "NGINX rollout did not complete on worker-a"
fi

pods="$("${COMPOSE[@]}" exec -T worker-a k3s kubectl -n "$NS" get pods -l app="$APP" --no-headers 2>/dev/null || true)"
printf '%s\n' "$pods"
printf '%s' "$pods" | grep -q "Running" || die "no Running NGINX pod found on worker-a"

echo
ok "FLEET E2E PASSED — master enrolled worker-a + worker-b and deployed NGINX onto worker-a"
echo "   Master UI:  $BASE  (admin / $ADMIN_PW)"
echo "   Tear down:  ./scripts/fleet-sim.sh --down"
