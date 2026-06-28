#!/usr/bin/env bash
# celeste-hyper bootstrap installer.
#
# Pasteable, idempotent: re-running pulls the configured branch, rebuilds
# front+back, and restarts the systemd service in place. Existing
# /etc/celeste-hyper/config.json and /var/lib/celeste-hyper/state.sqlite are
# preserved across upgrades.
#
# Usage (curl | bash):
#   curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/bootstrap.sh | sudo bash
#
# With overrides:
#   curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/bootstrap.sh | sudo REF=main bash
#   curl -fsSL https://raw.githubusercontent.com/Celeste-inc/celeste-hyper/main/deploy/bootstrap.sh | sudo INSTALL_CLUSTER=true CLUSTER_MODE=k3s bash
#
# Tunables (env vars):
#   REPO_URL         default: https://github.com/Celeste-inc/celeste-hyper.git
#   REF              default: main (branch, tag, or sha)
#   SRC_DIR          default: /opt/celeste-hyper/source
#   PREFIX           default: /opt/celeste-hyper
#   CONFIG_DIR       default: /etc/celeste-hyper
#   STATE_DIR        default: /var/lib/celeste-hyper
#   BUN_VERSION      default: 1.3.14
#   TARGET_ARCH      default: auto (x64|arm64)
#   FORCE_REBUILD    default: false (set true to rebuild even when HEAD is unchanged)
#   SKIP_BUILD       default: false (set true to skip build, only run installer)
#   INSTALL_KUBECTL  default: true
#   INSTALL_CLUSTER  default: false (set true to provision k3s on this host)
#   CLUSTER_MODE     default: auto  (auto|k3s|k8s)
#   R2_ENDPOINT_URL, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_REGION
#                    forwarded to install.sh on first run (config seeding)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Celeste-inc/celeste-hyper.git}"
REF="${REF:-main}"
SRC_DIR="${SRC_DIR:-/opt/celeste-hyper/source}"
PREFIX="${PREFIX:-/opt/celeste-hyper}"
CONFIG_DIR="${CONFIG_DIR:-/etc/celeste-hyper}"
STATE_DIR="${STATE_DIR:-/var/lib/celeste-hyper}"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
TARGET_ARCH="${TARGET_ARCH:-auto}"
FORCE_REBUILD="${FORCE_REBUILD:-false}"
SKIP_BUILD="${SKIP_BUILD:-false}"
INSTALL_KUBECTL="${INSTALL_KUBECTL:-true}"
INSTALL_CLUSTER="${INSTALL_CLUSTER:-false}"
CLUSTER_MODE="${CLUSTER_MODE:-auto}"

if [ "$(id -u)" != "0" ]; then
  echo "must run as root (try: curl ... | sudo bash)" >&2
  exit 1
fi

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; }

cleanup_staging=""
on_exit() {
  [ -n "${cleanup_staging}" ] && [ -d "${cleanup_staging}" ] && rm -rf "${cleanup_staging}"
}
trap on_exit EXIT

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) err "unsupported architecture: $(uname -m)"; exit 2 ;;
  esac
}

ensure_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    log "installing base packages via apt"
    DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip bash >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    log "installing base packages via dnf"
    dnf install -y ca-certificates curl git unzip bash >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    log "installing base packages via yum"
    yum install -y ca-certificates curl git unzip bash >/dev/null
  elif command -v apk >/dev/null 2>&1; then
    log "installing base packages via apk"
    apk add --no-cache ca-certificates curl git unzip bash >/dev/null
  else
    log "no supported package manager — assuming git/curl/unzip are present"
  fi
}

ensure_bun() {
  if [ -x /usr/local/bin/bun ] \
     && [ "$(/usr/local/bin/bun --version 2>/dev/null || true)" = "${BUN_VERSION}" ]; then
    log "bun ${BUN_VERSION} already installed"
    return
  fi
  log "installing bun ${BUN_VERSION}"
  rm -rf /opt/bun
  mkdir -p /opt/bun
  BUN_INSTALL=/opt/bun curl -fsSL https://bun.sh/install \
    | BUN_INSTALL=/opt/bun bash -s -- "bun-v${BUN_VERSION}" >/dev/null
  ln -sf /opt/bun/bin/bun /usr/local/bin/bun
  ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx
  /usr/local/bin/bun --version
}

ensure_kubectl() {
  [ "${INSTALL_KUBECTL}" = "true" ] || { log "skipping kubectl (INSTALL_KUBECTL=false)"; return; }
  if command -v kubectl >/dev/null 2>&1; then
    log "kubectl already installed"
    return
  fi
  local karch
  case "${ARCH}" in
    x64) karch=amd64 ;;
    arm64) karch=arm64 ;;
  esac
  local kver
  kver="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
  log "installing kubectl ${kver}"
  curl -fsSL "https://dl.k8s.io/release/${kver}/bin/linux/${karch}/kubectl" \
    -o /usr/local/bin/kubectl
  chmod 0755 /usr/local/bin/kubectl
}

sync_source() {
  install -d -m 0755 "$(dirname "${SRC_DIR}")"
  if [ -d "${SRC_DIR}/.git" ]; then
    log "updating ${SRC_DIR} from ${REPO_URL} (${REF})"
    git -C "${SRC_DIR}" remote set-url origin "${REPO_URL}"
    git -C "${SRC_DIR}" fetch --tags --prune --depth=1 origin "${REF}"
    git -C "${SRC_DIR}" reset --hard FETCH_HEAD
    git -C "${SRC_DIR}" clean -fd -e node_modules -e frontend/node_modules
  else
    log "cloning ${REPO_URL} (${REF}) → ${SRC_DIR}"
    git clone --depth=1 --branch "${REF}" "${REPO_URL}" "${SRC_DIR}"
  fi
  CURRENT_REV="$(git -C "${SRC_DIR}" rev-parse HEAD)"
  log "source revision: ${CURRENT_REV}"
}

build_artifact() {
  local binary="${SRC_DIR}/build/celeste-hyper-linux-${ARCH}"
  local rev_file="${PREFIX}/.installed-rev"
  local installed_rev=""
  [ -f "${rev_file}" ] && installed_rev="$(cat "${rev_file}" 2>/dev/null || true)"
  local installed_binary="${PREFIX}/bin/celeste-hyper"

  if [ "${SKIP_BUILD}" = "true" ]; then
    log "SKIP_BUILD=true — skipping build"
    return
  fi
  if [ "${FORCE_REBUILD}" != "true" ] \
     && [ -f "${binary}" ] \
     && [ -f "${installed_binary}" ] \
     && [ "${installed_rev}" = "${CURRENT_REV}" ]; then
    log "binary already up to date for ${CURRENT_REV} — skipping build"
    return
  fi
  log "installing backend deps"
  ( cd "${SRC_DIR}" && bun install --frozen-lockfile )
  log "installing frontend deps"
  ( cd "${SRC_DIR}/frontend" && bun install --frozen-lockfile )
  log "building celeste-hyper for linux-${ARCH}"
  ( cd "${SRC_DIR}" && bun run "build:linux-${ARCH}" )
  if [ ! -f "${binary}" ]; then
    err "build did not produce ${binary}"
    exit 1
  fi
}

run_installer() {
  local binary="${SRC_DIR}/build/celeste-hyper-linux-${ARCH}"
  if [ ! -f "${binary}" ]; then
    err "binary missing at ${binary} (try without SKIP_BUILD=true)"
    exit 1
  fi
  cleanup_staging="$(mktemp -d -t celeste-hyper-install.XXXXXX)"
  install -m 0755 "${binary}" "${cleanup_staging}/celeste-hyper-linux-${ARCH}"
  install -m 0644 "${SRC_DIR}/deploy/celeste-hyper.service" "${cleanup_staging}/celeste-hyper.service"
  install -m 0755 "${SRC_DIR}/deploy/install.sh"           "${cleanup_staging}/install.sh"
  [ -f "${SRC_DIR}/config.example.json" ] \
    && install -m 0644 "${SRC_DIR}/config.example.json"   "${cleanup_staging}/config.example.json"
  [ -f "${SRC_DIR}/README.md" ] \
    && install -m 0644 "${SRC_DIR}/README.md"             "${cleanup_staging}/README.md"

  log "running deploy/install.sh"
  (
    cd "${cleanup_staging}"
    BINARY="./celeste-hyper-linux-${ARCH}" \
    PREFIX="${PREFIX}" \
    CONFIG_DIR="${CONFIG_DIR}" \
    STATE_DIR="${STATE_DIR}" \
    CLUSTER_MODE="${CLUSTER_MODE}" \
    INSTALL_CLUSTER="${INSTALL_CLUSTER}" \
    INSTALL_KUBECTL=false \
    R2_ENDPOINT_URL="${R2_ENDPOINT_URL:-}" \
    R2_BUCKET="${R2_BUCKET:-}" \
    R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" \
    R2_REGION="${R2_REGION:-auto}" \
    bash ./install.sh
  )

  install -d -m 0755 "${PREFIX}"
  echo "${CURRENT_REV}" > "${PREFIX}/.installed-rev"
}

main() {
  ARCH="$([ "${TARGET_ARCH}" = "auto" ] && detect_arch || echo "${TARGET_ARCH}")"
  log "celeste-hyper bootstrap (arch=${ARCH}, ref=${REF})"
  ensure_packages
  ensure_bun
  ensure_kubectl
  sync_source
  build_artifact
  run_installer
  if command -v systemctl >/dev/null 2>&1; then
    log "done. tail logs: journalctl -u celeste-hyper -f"
  else
    log "done. tail logs: tail -f ${STATE_DIR}/celeste-hyper.log"
  fi
}

main "$@"
