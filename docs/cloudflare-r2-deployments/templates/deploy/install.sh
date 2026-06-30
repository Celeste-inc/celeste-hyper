#!/usr/bin/env bash
# Loads the bundled docker image into the local node's container runtime and
# applies the k8s manifests to the configured kubectl context. Mirrors the
# apply order celeste-hyper's r2-bundle deployer uses (namespace first, then
# every other manifest, *.example.yaml skipped), so a manual run behaves the
# same way an automated one would. See ../../README.md.
#
# Before using: replace SVC_NAME below with your service name (one-time edit,
# same value as IMAGE_NAME in the workflow and __SERVICE_NAME__ in k8s/*.yaml).
#
# Usage:
#   ./install.sh                            # auto-detect runtime, current kubectl context
#   KUBECTL_CONTEXT=k3s-prod ./install.sh   # specific context
#   RUNTIME=docker ./install.sh             # force docker load (default: k3s if present, else docker)
#   NAMESPACE=my-namespace ./install.sh     # override namespace (default: derived from image name)
#
# Re-runnable: kubectl apply is idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# Must match IMAGE_NAME in the GitHub Actions workflow and __SERVICE_NAME__ in
# k8s/*.yaml. Knowing the name up front (rather than splitting it back out of
# the tar filename) is what lets DERIVED_TAG below stay correct even when the
# tag itself contains a hyphen (e.g. a pre-release tag like v1.2.3-rc1).
SVC_NAME="__SERVICE_NAME__"

IMAGE_TAR="$(ls -1 "${SVC_NAME}"-*-amd64.tar 2>/dev/null | head -1 || true)"
if [ -z "${IMAGE_TAR}" ]; then
  echo "error: no ${SVC_NAME}-*-amd64.tar found next to install.sh" >&2
  exit 1
fi

DERIVED_TAG="${IMAGE_TAR#"${SVC_NAME}"-}"
DERIVED_TAG="${DERIVED_TAG%-amd64.tar}"
IMAGE_REF="docker.io/library/${SVC_NAME}:${DERIVED_TAG}"
NAMESPACE="${NAMESPACE:-${SVC_NAME}}"

if [ -z "${RUNTIME:-}" ]; then
  if command -v k3s >/dev/null 2>&1; then
    RUNTIME=k3s
  else
    RUNTIME=docker
  fi
fi

echo "==> loading ${IMAGE_TAR} as ${IMAGE_REF} via ${RUNTIME}"
case "${RUNTIME}" in
  k3s)        sudo k3s ctr images import "${IMAGE_TAR}" ;;
  docker)     docker load -i "${IMAGE_TAR}" ;;
  containerd) sudo ctr -n=k8s.io images import "${IMAGE_TAR}" ;;
  *)
    echo "error: unknown RUNTIME=${RUNTIME} (expected k3s|docker|containerd)" >&2
    exit 1 ;;
esac

KCTL=(kubectl)
[ -n "${KUBECTL_CONTEXT:-}" ] && KCTL+=(--context "${KUBECTL_CONTEXT}")

# Prefer <name>.rendered.yaml (tag already baked in at build time), fall back
# to the template version keyed by __IMAGE_TAG__.
apply_manifest() {
  local file="$1"
  local rendered="${file%.yaml}.rendered.yaml"
  if [ -f "${rendered}" ]; then
    "${KCTL[@]}" apply -f "${rendered}"
  else
    sed "s|__IMAGE_TAG__|${DERIVED_TAG}|g" "${file}" | "${KCTL[@]}" apply -f -
  fi
}

echo "==> namespace"
[ -f k8s/namespace.yaml ] && apply_manifest k8s/namespace.yaml

echo "==> remaining manifests"
for f in k8s/*.yaml; do
  base="$(basename "$f")"
  case "$base" in
    namespace.yaml|*.example.yaml|*.rendered.yaml) continue ;;
  esac
  echo "    ${base}"
  apply_manifest "$f"
done

if ls k8s/*.example.yaml >/dev/null 2>&1; then
  echo "==> note: k8s/*.example.yaml were NOT applied — they're illustrative only."
  echo "    Create the real ConfigMap/Secret from your own env files instead, e.g.:"
  echo "      kubectl -n ${NAMESPACE} create configmap ${SVC_NAME}-config --from-env-file=config.env"
  echo "      kubectl -n ${NAMESPACE} create secret    ${SVC_NAME}-secret --from-env-file=secret.env"
fi

echo "==> rollout status"
"${KCTL[@]}" -n "${NAMESPACE}" rollout status "deployment/${SVC_NAME}" --timeout=180s
echo "done."
