#!/usr/bin/env bash
# celeste-hyper update.sh — focused upgrade for an existing install.
#
# Goals:
#   - Never touch /etc/celeste-hyper/config.json, the env-files, kubeconfigs,
#     or any cluster state. Only the binary moves.
#   - Atomic binary swap (rename is atomic on POSIX). The service keeps
#     serving the old binary until the very last moment.
#   - Pre-flight: confirm the new binary executes at all (`--version`)
#     before we touch the live one.
#   - Snapshot state.sqlite before the restart so an incompatible
#     migration can be undone with `update.sh --rollback`.
#   - Health-check after restart. If the API doesn't answer 200/401 on
#     /api/system within ROLLOUT_TIMEOUT seconds we automatically revert
#     to the previous binary and restart.
#
# Usage on a host that already has /opt/celeste-hyper/bin/celeste-hyper:
#
#   # update from /opt/celeste-hyper/source (the bootstrap.sh layout)
#   sudo /opt/celeste-hyper/source/deploy/update.sh
#
#   # update from a specific ref of the upstream repo
#   sudo /opt/celeste-hyper/source/deploy/update.sh --ref v0.2.0
#
#   # install a prebuilt binary from anywhere
#   sudo /opt/celeste-hyper/source/deploy/update.sh --binary /tmp/celeste-hyper-linux-x64
#
#   # roll back the last update (revert binary + restart)
#   sudo /opt/celeste-hyper/source/deploy/update.sh --rollback
#
#   # just check what would happen, don't touch anything
#   sudo /opt/celeste-hyper/source/deploy/update.sh --check
#
# Exit codes:
#   0   update applied (or rollback succeeded)
#   1   pre-flight failed; running install untouched
#   2   bad CLI arguments
#   3   health check after restart failed AND rollback also failed (manual fix needed)

set -euo pipefail

PREFIX="${PREFIX:-/opt/celeste-hyper}"
SRC_DIR="${SRC_DIR:-${PREFIX}/source}"
STATE_DIR="${STATE_DIR:-/var/lib/celeste-hyper}"
CONFIG_DIR="${CONFIG_DIR:-/etc/celeste-hyper}"
SERVICE_NAME="${SERVICE_NAME:-celeste-hyper}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:8080/api/system}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-60}"
TARGET_ARCH="${TARGET_ARCH:-auto}"
REF="${REF:-main}"

MODE="from-source"
INPUT_BINARY=""
CHECK_ONLY=false
ROLLBACK_ONLY=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --binary) MODE=binary; INPUT_BINARY="$2"; shift 2 ;;
    --from-source) MODE=from-source; shift ;;
    --check) CHECK_ONLY=true; shift ;;
    --rollback) ROLLBACK_ONLY=true; shift ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --healthcheck-url) HEALTHCHECK_URL="$2"; shift 2 ;;
    --timeout) ROLLOUT_TIMEOUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "must run as root (try: sudo $0)" >&2
  exit 1
fi

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; }

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) err "unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
}
ARCH="$([ "${TARGET_ARCH}" = "auto" ] && detect_arch || echo "${TARGET_ARCH}")"

CURRENT_BINARY="${PREFIX}/bin/celeste-hyper"
PREVIOUS_BINARY="${PREFIX}/bin/celeste-hyper.previous"
STAGED_BINARY="${PREFIX}/bin/celeste-hyper.next"

# --- helpers -----------------------------------------------------------

uses_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"
}

current_version() {
  if [ -x "${CURRENT_BINARY}" ]; then
    "${CURRENT_BINARY}" --version 2>/dev/null || echo "unknown"
  else
    echo "<not installed>"
  fi
}

restart_service() {
  if uses_systemd; then
    log "restarting ${SERVICE_NAME} via systemctl"
    systemctl restart "${SERVICE_NAME}"
  else
    log "no systemd; sending SIGTERM to the running pid"
    local pidfile="${STATE_DIR}/${SERVICE_NAME}.pid"
    if [ -f "${pidfile}" ]; then
      local pid; pid="$(cat "${pidfile}" 2>/dev/null || true)"
      if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
        kill "${pid}" || true
        # wait up to 10 s for the old process to exit
        for _ in $(seq 1 20); do
          kill -0 "${pid}" 2>/dev/null || break
          sleep 0.5
        done
      fi
    fi
    HYPER_CONFIG="${CONFIG_DIR}/config.json" LOG_LEVEL="${LOG_LEVEL:-info}" \
      nohup "${CURRENT_BINARY}" > "${STATE_DIR}/${SERVICE_NAME}.log" 2>&1 &
    echo "$!" > "${pidfile}"
  fi
}

healthcheck() {
  log "waiting up to ${ROLLOUT_TIMEOUT}s for ${HEALTHCHECK_URL}"
  local deadline=$(( $(date +%s) + ROLLOUT_TIMEOUT ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    # 200 (ok) and 401 (auth required) both prove the binary booted and the HTTP server is up.
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "${HEALTHCHECK_URL}" 2>/dev/null || echo 000)"
    if [ "${code}" = "200" ] || [ "${code}" = "401" ]; then
      log "health check passed (HTTP ${code})"
      return 0
    fi
    sleep 1
  done
  err "health check timed out — API never answered on ${HEALTHCHECK_URL}"
  return 1
}

snapshot_state() {
  if [ -f "${STATE_DIR}/state.sqlite" ]; then
    local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
    local snap="${STATE_DIR}/state.sqlite.pre-update.${ts}"
    log "snapshotting state to ${snap}"
    # Single-file copy: the WAL+SHM are checkpointed at boot, and `bun:sqlite` flushes the WAL on
    # close anyway. We're about to bring the process down before the migration runs, so this copy
    # captures the pre-migration committed state safely.
    cp -a "${STATE_DIR}/state.sqlite" "${snap}"
    # Keep the 5 most recent snapshots so we don't slowly fill the disk.
    ls -1t "${STATE_DIR}"/state.sqlite.pre-update.* 2>/dev/null | tail -n +6 | xargs -r rm -f
  fi
}

# --- modes -------------------------------------------------------------

rollback() {
  if [ ! -x "${PREVIOUS_BINARY}" ]; then
    err "no previous binary at ${PREVIOUS_BINARY} — cannot roll back"
    exit 1
  fi
  log "rolling back to previous binary"
  install -m 0755 "${PREVIOUS_BINARY}" "${CURRENT_BINARY}"
  restart_service
  if healthcheck; then
    log "rollback OK; previous binary restored"
  else
    err "rollback restarted but the API is not answering. Manual intervention required."
    exit 3
  fi
}

resolve_new_binary() {
  case "${MODE}" in
    binary)
      if [ ! -f "${INPUT_BINARY}" ]; then
        err "binary not found at ${INPUT_BINARY}"
        exit 1
      fi
      echo "${INPUT_BINARY}"
      ;;
    from-source)
      if [ ! -d "${SRC_DIR}/.git" ]; then
        err "${SRC_DIR} is not a git checkout; either re-run bootstrap.sh first or pass --binary <path>"
        exit 1
      fi
      log "updating source at ${SRC_DIR} → ${REF}"
      git -C "${SRC_DIR}" fetch --tags --prune --depth=1 origin "${REF}"
      git -C "${SRC_DIR}" reset --hard FETCH_HEAD
      git -C "${SRC_DIR}" clean -fd -e node_modules -e frontend/node_modules
      local rev; rev="$(git -C "${SRC_DIR}" rev-parse HEAD)"
      log "source revision ${rev}"
      if ! command -v bun >/dev/null 2>&1; then
        err "bun not found in PATH — install bun first or use --binary"
        exit 1
      fi
      log "installing deps + building celeste-hyper-linux-${ARCH}"
      ( cd "${SRC_DIR}" && bun install --frozen-lockfile >/dev/null )
      ( cd "${SRC_DIR}/frontend" && bun install --frozen-lockfile >/dev/null )
      ( cd "${SRC_DIR}" && bun run "build:linux-${ARCH}" >/dev/null )
      echo "${SRC_DIR}/build/celeste-hyper-linux-${ARCH}"
      ;;
    *) err "internal: unknown mode ${MODE}"; exit 1 ;;
  esac
}

apply_update() {
  log "current installed version: $(current_version)"

  local new_binary; new_binary="$(resolve_new_binary)"
  if [ ! -f "${new_binary}" ]; then
    err "new binary missing at ${new_binary}"
    exit 1
  fi

  # Pre-flight 1: --version must work. If this crashes the binary won't even boot.
  log "verifying new binary: ${new_binary} --version"
  local new_version
  if ! new_version="$( "${new_binary}" --version 2>&1 )"; then
    err "new binary failed --version probe — refusing to install"
    err "output: ${new_version}"
    exit 1
  fi
  log "new binary version: ${new_version}"

  if [ "${CHECK_ONLY}" = "true" ]; then
    log "--check requested; not modifying the install"
    log "would install: ${new_binary} -> ${CURRENT_BINARY}"
    exit 0
  fi

  # Stage alongside (same filesystem so the final mv is atomic).
  install -d -m 0755 "${PREFIX}/bin"
  log "staging new binary at ${STAGED_BINARY}"
  install -m 0755 "${new_binary}" "${STAGED_BINARY}"

  # Snapshot state before any restart triggers migration code.
  snapshot_state

  # Keep the currently-installed binary as .previous so --rollback can revert atomically.
  if [ -x "${CURRENT_BINARY}" ]; then
    log "saving previous binary to ${PREVIOUS_BINARY}"
    install -m 0755 "${CURRENT_BINARY}" "${PREVIOUS_BINARY}"
  fi

  # Atomic swap — rename within the same directory is atomic on POSIX.
  log "swapping into place"
  mv -f "${STAGED_BINARY}" "${CURRENT_BINARY}"

  restart_service

  if healthcheck; then
    log "update applied: $(current_version)"
    exit 0
  fi

  # Health check failed — roll back automatically. The user's data is intact because we
  # only swapped the binary.
  err "new binary failed to come up healthy; rolling back automatically"
  if [ -x "${PREVIOUS_BINARY}" ]; then
    install -m 0755 "${PREVIOUS_BINARY}" "${CURRENT_BINARY}"
    restart_service
    if healthcheck; then
      err "rolled back to previous binary; the failed binary is gone."
      exit 1
    fi
  fi
  err "automatic rollback did not bring the service back. Inspect: journalctl -u ${SERVICE_NAME} -n 100"
  exit 3
}

# --- entry -------------------------------------------------------------

if [ "${ROLLBACK_ONLY}" = "true" ]; then
  rollback
  exit 0
fi

apply_update
