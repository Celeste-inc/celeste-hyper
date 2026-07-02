#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f compose.fleet.yaml)
BASE="${BASE:-http://localhost:8088}"
COUNT="${COUNT:-40}"
CONCURRENCY="${CONCURRENCY:-10}"
ADMIN_PW="${ADMIN_PW:-fleet-stress-pw-1}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--down" ]; then "${COMPOSE[@]}" down -v; exit 0; fi

log "starting fleet master for enrollment stress"
"${COMPOSE[@]}" up -d --build master >/dev/null

log "waiting for master API at ${BASE}"
for i in $(seq 1 60); do
  curl -fsS "${BASE}/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && die "master did not come up"
  sleep 2
done

log "running stress workload inside the compose network (count=${COUNT}, concurrency=${CONCURRENCY})"
docker run --rm --network celeste-fleet_fleet \
  -e COUNT="${COUNT}" \
  -e CONCURRENCY="${CONCURRENCY}" \
  -e ADMIN_PW="${ADMIN_PW}" \
  alpine:3.20 sh -c 'apk add --no-cache bash curl jq >/dev/null; exec bash -s' <<'BASH'
set -euo pipefail

BASE="http://master:8080"
JAR="$(mktemp)"
TOKENS="$(mktemp)"
STATUSES="$(mktemp)"
trap 'rm -f "$JAR" "$TOKENS" "$STATUSES"' EXIT

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE$path" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" --data-binary "$body"
    return
  fi
  curl -sS -X "$method" "$BASE$path" -b "$JAR" -c "$JAR" -H "X-CSRF-Token: $CSRF"
}

login_default() {
  curl -sS -X POST "$BASE/api/login" -c "$JAR" -H 'Content-Type: application/json' --data '{"username":"admin","password":"admin"}' >/dev/null
  CSRF="$(curl -sS "$BASE/api/me" -b "$JAR" | jq -r '.csrfToken // empty')"
  [ -n "$CSRF" ] || return 1
  api POST /api/change-password "$(jq -n --arg p "$ADMIN_PW" '{currentPassword:"admin",newPassword:$p}')" >/dev/null
}

login_changed() {
  curl -sS -X POST "$BASE/api/login" -c "$JAR" -H 'Content-Type: application/json' --data "$(jq -n --arg p "$ADMIN_PW" '{username:"admin",password:$p}')" >/dev/null
  CSRF="$(curl -sS "$BASE/api/me" -b "$JAR" | jq -r '.csrfToken // empty')"
  [ -n "$CSRF" ]
}

CSRF=""
login_default || login_changed
login_changed

run_id="$(date +%s)-$$"
for i in $(seq 1 "$COUNT"); do
  cid="stress-${run_id}-${i}"
  resp="$(api POST /api/enrollment-tokens "$(jq -n --arg cid "$cid" '{name:$cid,clusterId:$cid,clusterName:$cid,runtime:"k3s",imageLoad:"remote-pull",expiresInMinutes:30}')")"
  tok="$(printf '%s' "$resp" | jq -r '.token // empty')"
  [ -n "$tok" ] || { printf '%s\n' "$resp" >&2; exit 10; }
  printf '%s %s\n' "$i" "$tok" >> "$TOKENS"
done

kubeconfig='apiVersion: v1
kind: Config
clusters:
  - name: worker
    cluster:
      server: https://127.0.0.1:6443
      certificate-authority-data: CA==
users:
  - name: worker
    user:
      token: stress-static-token
contexts:
  - name: worker
    context: { cluster: worker, user: worker }
current-context: worker
'

enroll_one() {
  local idx="$1" tok="$2" body code
  body="$(jq -n --arg token "$tok" --arg kc "$kubeconfig" --arg node "stress-$idx" '{token:$token,kubeconfig:$kc,runtime:"k3s",nodeName:$node}')"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/enroll" -H 'Content-Type: application/json' --data-binary "$body")"
  printf '%s\n' "$code" >> "$STATUSES"
}

active=0
while read -r idx tok; do
  enroll_one "$idx" "$tok" &
  active=$((active + 1))
  if [ "$active" -ge "$CONCURRENCY" ]; then
    wait -n
    active=$((active - 1))
  fi
done < "$TOKENS"
wait

bad="$(grep -v '^201$' "$STATUSES" || true)"
[ -z "$bad" ] || { printf 'unexpected enroll statuses:\n%s\n' "$bad" >&2; exit 11; }

last=""
for i in $(seq 1 6); do
  body="$(jq -n --arg kc "$kubeconfig" '{token:"che_rotating_guess",kubeconfig:$kc}')"
  last="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/enroll" -H 'Content-Type: application/json' -H "X-Forwarded-For: 198.51.100.$i" --data-binary "$body")"
done
[ "$last" = "429" ] || { printf 'expected rotating-XFF guess to end at 429, got %s\n' "$last" >&2; exit 12; }

printf 'ENROLL_STRESS_PASSED count=%s concurrency=%s\n' "$COUNT" "$CONCURRENCY"
BASH

ok "ENROLL_STRESS_PASSED"
