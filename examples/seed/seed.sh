#!/bin/sh
# Seed a k3s cluster by:
#   1. waiting for k3s to write its kubeconfig
#   2. rewriting the embedded server URL so the celeste-hyper container can reach it
#   3. applying the manifests bundled into /manifests
#
# Required env:
#   K3S_SERVICE      Compose hostname of the k3s service (e.g. "k3s-primary")
#   ROLLOUT_NS       Namespace where the workload rolls out
#   ROLLOUT_NAME     Deployment to wait on
#
# Optional env:
#   KUBECONFIG_SRC   Default: /kubeconfig-src/kubeconfig.yaml
#   KUBECONFIG_OUT   Default: /kubeconfig-out/kubeconfig
set -eu

KUBECONFIG_SRC="${KUBECONFIG_SRC:-/kubeconfig-src/kubeconfig.yaml}"
KUBECONFIG_OUT="${KUBECONFIG_OUT:-/kubeconfig-out/kubeconfig}"
: "${K3S_SERVICE:?must be set}"
: "${ROLLOUT_NS:?must be set}"
: "${ROLLOUT_NAME:?must be set}"

echo "==> waiting for k3s kubeconfig at ${KUBECONFIG_SRC}"
i=0
while [ ! -f "${KUBECONFIG_SRC}" ] && [ "$i" -lt 120 ]; do
  i=$((i + 1)); sleep 1
done
[ -f "${KUBECONFIG_SRC}" ] || { echo "kubeconfig never appeared" >&2; exit 1; }

echo "==> rewriting server URL -> https://${K3S_SERVICE}:6443 -> ${KUBECONFIG_OUT}"
sed "s|server: https://127.0.0.1:6443|server: https://${K3S_SERVICE}:6443|" "${KUBECONFIG_SRC}" > "${KUBECONFIG_OUT}"
chmod 0644 "${KUBECONFIG_OUT}"
export KUBECONFIG="${KUBECONFIG_OUT}"

echo "==> waiting for cluster to respond"
i=0
while ! kubectl get nodes >/dev/null 2>&1 && [ "$i" -lt 120 ]; do
  i=$((i + 1)); sleep 1
done
kubectl get nodes

echo "==> applying namespace first"
if [ -f /manifests/namespace.yaml ]; then
  kubectl apply -f /manifests/namespace.yaml
  for i in 1 2 3 4 5; do
    kubectl get ns "${ROLLOUT_NS}" >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo "==> applying remaining manifests"
for f in /manifests/*.yaml; do
  case "$(basename "$f")" in
    namespace.yaml) ;;
    *) kubectl apply -f "$f" ;;
  esac
done

echo "==> waiting for ${ROLLOUT_NS}/${ROLLOUT_NAME} rollout (best-effort)"
kubectl -n "${ROLLOUT_NS}" rollout status "deployment/${ROLLOUT_NAME}" --timeout=180s || \
  echo "==> rollout watch timed out; manifests are applied, hyper poller will pick them up"

echo "==> seed done"
