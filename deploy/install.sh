#!/usr/bin/env bash
# celeste-hyper installer — drops the binary, systemd unit, config skeleton,
# and starts the service. Idempotent: rerun to upgrade.
#
# Usage on the VM:
#   sudo BINARY=./celeste-hyper-linux-x64 ./deploy/install.sh
#   sudo ./deploy/install.sh --cluster-mode k3s --install-cluster \
#     --r2-endpoint-url https://<account>.r2.cloudflarestorage.com --r2-bucket service-builds \
#     --r2-access-key-id <key> --r2-secret-access-key <secret>
#
# Required env:
#   BINARY  — path to the prebuilt celeste-hyper binary (default: ./celeste-hyper-linux-x64)
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "must run as root" >&2
  exit 1
fi

BINARY="${BINARY:-./celeste-hyper-linux-x64}"
PREFIX="${PREFIX:-/opt/celeste-hyper}"
CONFIG_DIR="${CONFIG_DIR:-/etc/celeste-hyper}"
STATE_DIR="${STATE_DIR:-/var/lib/celeste-hyper}"
CLUSTER_MODE="${CLUSTER_MODE:-auto}"
INSTALL_CLUSTER="${INSTALL_CLUSTER:-false}"
CLUSTER_ID="${CLUSTER_ID:-local}"
CLUSTER_NAME="${CLUSTER_NAME:-Local cluster}"
NAMESPACE="${NAMESPACE:-default}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-}"
RUNTIME="${RUNTIME:-}"
R2_ENDPOINT_URL="${R2_ENDPOINT_URL:-}"
R2_BUCKET="${R2_BUCKET:-}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
R2_REGION="${R2_REGION:-auto}"
START_WITHOUT_SYSTEMD="${START_WITHOUT_SYSTEMD:-true}"
INSTALL_KUBECTL="${INSTALL_KUBECTL:-true}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cluster-mode) CLUSTER_MODE="$2"; shift 2 ;;
    --install-cluster) INSTALL_CLUSTER=true; shift ;;
    --cluster-id) CLUSTER_ID="$2"; shift 2 ;;
    --cluster-name) CLUSTER_NAME="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --kubeconfig) KUBECONFIG_PATH="$2"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    --r2-endpoint-url) R2_ENDPOINT_URL="$2"; shift 2 ;;
    --r2-bucket) R2_BUCKET="$2"; shift 2 ;;
    --r2-access-key-id) R2_ACCESS_KEY_ID="$2"; shift 2 ;;
    --r2-secret-access-key) R2_SECRET_ACCESS_KEY="$2"; shift 2 ;;
    --r2-region) R2_REGION="$2"; shift 2 ;;
    --no-install-kubectl) INSTALL_KUBECTL=false; shift ;;
    --no-start-without-systemd) START_WITHOUT_SYSTEMD=false; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "${BINARY}" ]; then
  echo "binary not found at ${BINARY}" >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  echo "==> ensuring Debian dependencies"
  apt-get update -y >/dev/null
  apt-get install -y ca-certificates curl >/dev/null
fi

if [ "${CLUSTER_MODE}" = "auto" ]; then
  if command -v k3s >/dev/null 2>&1 || [ -f /etc/rancher/k3s/k3s.yaml ]; then
    CLUSTER_MODE=k3s
  else
    CLUSTER_MODE=k8s
  fi
fi

if [ "${CLUSTER_MODE}" = "k3s" ]; then
  KUBECONFIG_PATH="${KUBECONFIG_PATH:-/etc/rancher/k3s/k3s.yaml}"
  if ! command -v k3s >/dev/null 2>&1 && [ "${INSTALL_CLUSTER}" = "true" ]; then
    echo "==> installing k3s"
    curl -sfL https://get.k3s.io | sh -
  fi
  if [ ! -f "${KUBECONFIG_PATH}" ]; then
    echo "warning: ${KUBECONFIG_PATH} not found; finish k3s setup or configure the cluster from the UI" >&2
  fi
elif [ "${CLUSTER_MODE}" = "k8s" ]; then
  KUBECONFIG_PATH="${KUBECONFIG_PATH:-${CONFIG_DIR}/clusters/${CLUSTER_ID}.kubeconfig}"
  if ! command -v kubectl >/dev/null 2>&1 && [ "${INSTALL_KUBECTL}" = "true" ]; then
    echo "==> installing kubectl"
    ARCH="$(uname -m)"
    case "${ARCH}" in
      x86_64|amd64) KARCH=amd64 ;;
      aarch64|arm64) KARCH=arm64 ;;
      *) echo "unsupported architecture for kubectl: ${ARCH}" >&2; exit 2 ;;
    esac
    KUBECTL_VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KARCH}/kubectl" -o /usr/local/bin/kubectl
    chmod 0755 /usr/local/bin/kubectl
  fi
else
  echo "invalid --cluster-mode ${CLUSTER_MODE}; expected auto|k3s|k8s" >&2
  exit 2
fi

echo "==> installing binary to ${PREFIX}/bin"
install -d -m 0755 "${PREFIX}/bin"
install -m 0755 "${BINARY}" "${PREFIX}/bin/celeste-hyper"

if [ -f "./README.md" ]; then
  install -m 0644 ./README.md "${PREFIX}/README.md"
fi

echo "==> ensuring config dir ${CONFIG_DIR}"
install -d -m 0750 "${CONFIG_DIR}"
install -d -m 0750 "${CONFIG_DIR}/services"
install -d -m 0750 "${CONFIG_DIR}/clusters"
if [ ! -f "${CONFIG_DIR}/config.json" ] && [ -f "./config.example.json" ]; then
  echo "==> writing ${CONFIG_DIR}/config.json"
  R2_ENDPOINT_JSON="${R2_ENDPOINT_URL:-https://example-account-id.r2.cloudflarestorage.com}"
  R2_BUCKET_JSON="${R2_BUCKET:-service-builds}"
  R2_KEY_JSON="${R2_ACCESS_KEY_ID:-change-me}"
  R2_SECRET_JSON="${R2_SECRET_ACCESS_KEY:-change-me}"
  RUNTIME_JSON="${RUNTIME:-containerd}"
  [ "${CLUSTER_MODE}" = "k3s" ] && RUNTIME_JSON="${RUNTIME:-k3s}"
  cat > "${CONFIG_DIR}/config.json" <<EOF
{
  "listen": { "host": "0.0.0.0", "port": 8080 },
  "r2": {
    "endpoint": "${R2_ENDPOINT_JSON}",
    "bucket": "${R2_BUCKET_JSON}",
    "accessKeyId": "${R2_KEY_JSON}",
    "secretAccessKey": "${R2_SECRET_JSON}",
    "region": "${R2_REGION}"
  },
  "k8s": { "kubeconfig": "${KUBECONFIG_PATH}", "runtime": "${RUNTIME_JSON}", "namespace": "${NAMESPACE}" },
  "stateDir": "${STATE_DIR}",
  "envFilesDir": "${CONFIG_DIR}/services",
  "workDir": "${STATE_DIR}/work",
  "poller": { "intervalSec": 60, "autoDeploy": false, "enabled": true },
  "services": [],
  "clusters": [{
    "id": "${CLUSTER_ID}",
    "name": "${CLUSTER_NAME}",
    "kubeconfigPath": "${KUBECONFIG_PATH}",
    "defaultNamespace": "${NAMESPACE}",
    "runtime": "${RUNTIME_JSON}"
  }]
}
EOF
  chmod 0640 "${CONFIG_DIR}/config.json"
  echo "    edit ${CONFIG_DIR}/config.json or complete Setup in the UI before deploying services"
fi

echo "==> ensuring state dir ${STATE_DIR}"
install -d -m 0750 "${STATE_DIR}"
install -d -m 0750 "${STATE_DIR}/work"

if command -v systemctl >/dev/null 2>&1; then
  echo "==> installing systemd unit"
  install -m 0644 ./celeste-hyper.service /etc/systemd/system/celeste-hyper.service
  systemctl daemon-reload

  if systemctl is-enabled celeste-hyper >/dev/null 2>&1; then
    echo "==> restarting celeste-hyper"
    systemctl restart celeste-hyper
  else
    echo "==> enabling celeste-hyper"
    systemctl enable celeste-hyper
    systemctl start celeste-hyper
  fi

  sleep 2
  systemctl --no-pager status celeste-hyper | head -15 || true
else
  echo "==> systemctl not found; skipping systemd unit"
  if [ "${START_WITHOUT_SYSTEMD}" = "true" ]; then
    echo "==> starting celeste-hyper directly"
    if [ -f "${STATE_DIR}/celeste-hyper.pid" ]; then
      OLD_PID="$(cat "${STATE_DIR}/celeste-hyper.pid" 2>/dev/null || true)"
      if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" >/dev/null 2>&1; then
        kill "${OLD_PID}" || true
      fi
    fi
    HYPER_CONFIG="${CONFIG_DIR}/config.json" LOG_LEVEL="${LOG_LEVEL:-info}" \
      nohup "${PREFIX}/bin/celeste-hyper" > "${STATE_DIR}/celeste-hyper.log" 2>&1 &
    echo "$!" > "${STATE_DIR}/celeste-hyper.pid"
    sleep 2
    if ! kill -0 "$(cat "${STATE_DIR}/celeste-hyper.pid")" >/dev/null 2>&1; then
      echo "celeste-hyper failed to start; log follows:" >&2
      cat "${STATE_DIR}/celeste-hyper.log" >&2 || true
      exit 1
    fi
    echo "    pid: $(cat "${STATE_DIR}/celeste-hyper.pid")"
    echo "    log: ${STATE_DIR}/celeste-hyper.log"
  else
    echo "    start manually with: HYPER_CONFIG=${CONFIG_DIR}/config.json ${PREFIX}/bin/celeste-hyper"
  fi
fi
echo
if command -v systemctl >/dev/null 2>&1; then
  echo "done. tail logs with: journalctl -u celeste-hyper -f"
else
  echo "done. tail logs with: tail -f ${STATE_DIR}/celeste-hyper.log"
fi
