#!/usr/bin/env bash
# celeste-hyper join.sh — turn THIS machine into a worker cluster and enroll it on a master.
#
# Run on a fresh LAN machine. It provisions a single-node k3s, pins the apiserver TLS cert to this
# host's LAN IP, and self-registers with the master's control plane using a one-shot enrollment token
# (minted in the master UI under Fleet → Add machine, or `POST /api/enrollment-tokens`). After this
# the master can deploy services (registry-pull/ACR, or r2-bundle via remote-pull) onto this machine.
#
# Usage (paste the exact command the master's "Add machine" panel prints):
#   curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/join.sh \
#     | sudo MASTER_URL=http://master.lan:8080 ENROLL_TOKEN=che_xxx bash
#
# Required:
#   MASTER_URL    base URL of the master (e.g. http://10.0.0.2:8080 — https strongly recommended)
#   ENROLL_TOKEN  one-shot enrollment token from the master (che_…)
#
# Optional:
#   ADVERTISE_IP  this host's LAN IP the master will reach it on (default: auto-detected)
#   NODE_NAME     k3s node name (default: hostname)
#   K3S_VERSION   pin the k3s channel/version (default: stable channel)
#   K3S_EXTRA     extra args appended to the k3s server install (e.g. "--disable=traefik")
set -euo pipefail

MASTER_URL="${MASTER_URL:-}"
ENROLL_TOKEN="${ENROLL_TOKEN:-}"
ADVERTISE_IP="${ADVERTISE_IP:-}"
NODE_NAME="${NODE_NAME:-$(hostname)}"
K3S_VERSION="${K3S_VERSION:-}"
K3S_EXTRA="${K3S_EXTRA:-}"
KUBECONFIG_PATH="/etc/rancher/k3s/k3s.yaml"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; }

if [ "$(id -u)" != "0" ]; then
  err "must run as root (try: curl ... | sudo MASTER_URL=... ENROLL_TOKEN=... bash)"
  exit 1
fi
if [ -z "${MASTER_URL}" ] || [ -z "${ENROLL_TOKEN}" ]; then
  err "MASTER_URL and ENROLL_TOKEN are required"
  exit 2
fi
case "${MASTER_URL}" in
  http://*) err "MASTER_URL is plaintext http:// — the enrollment token and kubeconfig will cross the network in the clear. Use https (a reverse proxy or VPN) outside a trusted LAN." ;;
esac

detect_ip() {
  # Source IP of the default route — the address other LAN hosts reach this machine on.
  local ip=""
  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')" || true
  [ -n "${ip}" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  echo "${ip}"
}

ensure_packages() {
  # ca-certificates is required for HTTPS (a bare Debian/Alpine image ships without it → curl fails
  # with "error setting certificate file"). jq builds the enroll JSON; curl talks to get.k3s.io + master.
  if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl jq >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates curl jq >/dev/null
  elif command -v yum >/dev/null 2>&1; then yum install -y ca-certificates curl jq >/dev/null
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates curl jq >/dev/null
  else err "need ca-certificates + curl + jq; install them and re-run"; exit 3
  fi
}

# k3s binary release used on no-init hosts (overridable via K3S_VERSION).
DEFAULT_K3S_BINARY_VERSION="v1.31.5+k3s1"

# True only when systemd is the init (the canonical `/run/systemd/system` check) — VMs / bare metal.
has_init() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

download_k3s_binary() {
  local ver="${K3S_VERSION:-${DEFAULT_K3S_BINARY_VERSION}}" bin
  case "$(uname -m)" in
    x86_64|amd64) bin="k3s" ;;
    aarch64|arm64) bin="k3s-arm64" ;;
    *) err "unsupported architecture: $(uname -m)"; exit 3 ;;
  esac
  log "downloading k3s ${ver} (${bin}) binary"
  # `+` in the version tag must be percent-encoded in the URL path.
  curl -sfL "https://github.com/k3s-io/k3s/releases/download/${ver//+/%2B}/${bin}" -o /usr/local/bin/k3s
  chmod 0755 /usr/local/bin/k3s
}

install_k3s() {
  if command -v k3s >/dev/null 2>&1 && [ -f "${KUBECONFIG_PATH}" ]; then
    log "k3s already present — reusing it"
    return
  fi
  log "installing single-node k3s (tls-san=${ADVERTISE_IP}, node=${NODE_NAME})"
  # 0600 kubeconfig (root reads it below); tls-san so the cert is valid for the host the master reaches.
  local exec_args="server --write-kubeconfig-mode 0600 --tls-san ${ADVERTISE_IP} --node-name ${NODE_NAME} ${K3S_EXTRA}"
  if has_init; then
    # Real host: the official installer sets up + starts the systemd service.
    # shellcheck disable=SC2086
    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="${K3S_VERSION}" INSTALL_K3S_EXEC="${exec_args}" sh -
  else
    # Container / minimal host with no init system: the installer refuses to run, so fetch the binary
    # directly and start the server detached ourselves.
    log "no init system detected — running k3s directly"
    download_k3s_binary
    # shellcheck disable=SC2086
    setsid /usr/local/bin/k3s ${exec_args} >/var/log/k3s.log 2>&1 </dev/null &
    log "k3s server started (logs: /var/log/k3s.log)"
  fi
}

wait_ready() {
  log "waiting for the k3s node to become Ready"
  for _ in $(seq 1 120); do
    if [ -f "${KUBECONFIG_PATH}" ] && k3s kubectl get nodes 2>/dev/null | grep -q ' Ready'; then
      return 0
    fi
    sleep 2
  done
  err "k3s did not become ready in time; check k3s logs (journalctl -u k3s -e or /var/log/k3s.log)"
  exit 4
}

main() {
  [ -n "${ADVERTISE_IP}" ] || ADVERTISE_IP="$(detect_ip)"
  if [ -z "${ADVERTISE_IP}" ]; then
    err "could not auto-detect this host's LAN IP — pass ADVERTISE_IP=<ip>"
    exit 5
  fi
  log "celeste-hyper join (master=${MASTER_URL}, advertise=${ADVERTISE_IP}, node=${NODE_NAME})"
  ensure_packages
  install_k3s
  wait_ready

  # Rewrite the loopback server URL k3s writes (https://127.0.0.1:6443) to the LAN IP the master uses.
  local kubeconfig
  kubeconfig="$(sed "s#server: https://127.0.0.1:6443#server: https://${ADVERTISE_IP}:6443#" "${KUBECONFIG_PATH}")"

  log "enrolling with the master"
  local body status_file http_code
  body="$(jq -n --arg token "${ENROLL_TOKEN}" --arg kc "${kubeconfig}" --arg node "${NODE_NAME}" \
    '{token:$token, kubeconfig:$kc, runtime:"k3s", nodeName:$node}')"
  status_file="$(mktemp)"
  http_code="$(printf '%s' "${body}" | curl -sS -o "${status_file}" -w '%{http_code}' \
    -X POST "${MASTER_URL%/}/api/enroll" \
    -H 'Content-Type: application/json' \
    --data-binary @-)" || { err "could not reach ${MASTER_URL}/api/enroll"; rm -f "${status_file}"; exit 6; }

  if [ "${http_code}" = "201" ]; then
    local cid
    cid="$(jq -r '.cluster.id // "?"' < "${status_file}" 2>/dev/null || echo '?')"
    rm -f "${status_file}"
    log "enrolled as cluster '${cid}'. Manage it from the master UI."
  else
    err "enrollment failed (HTTP ${http_code}): $(cat "${status_file}" 2>/dev/null)"
    err "enrollment tokens are single-use and short-lived — mint a fresh one on the master and re-run."
    rm -f "${status_file}"
    exit 7
  fi
}

main "$@"
