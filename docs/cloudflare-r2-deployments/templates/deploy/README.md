# Deploy bundle

This file ships inside the bundle produced by `build-and-upload-to-r2`. Contents:

- `<service-name>-<tag>-amd64.tar` — linux/amd64 Docker image, ready for `ctr import` / `docker load`
- `k8s/` — manifests for namespace `<namespace>`:
  - `namespace.yaml`
  - `deployment.yaml` (template, keyed by `__IMAGE_TAG__`)
  - `deployment.rendered.yaml` (tag already substituted — apply this one directly)
  - `service.yaml`
- `install.sh` — loads the image into the node's runtime and applies the manifests

## Quick use (k3s)

```bash
aws s3 sync s3://<bucket>/<service-name>/<tag>/ ./<service-name>-<tag>/ \
  --endpoint-url <r2-endpoint-url>

cd <service-name>-<tag>
./install.sh
```

Optional env vars: `KUBECTL_CONTEXT`, `RUNTIME` (`k3s` | `docker` | `containerd`), `NAMESPACE`.

## Equivalent manual steps

```bash
sudo k3s ctr images import <service-name>-<tag>-amd64.tar
# or: docker load -i <service-name>-<tag>-amd64.tar

kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/deployment.rendered.yaml
kubectl apply -f k8s/service.yaml

kubectl -n <namespace> rollout status deployment/<service-name> --timeout=180s
```

## Automatic deploys

If the bucket this bundle came from is registered with a poll-based `r2-bundle` deployer (for
example celeste-hyper), none of the above is necessary — the deployer discovers the new tag,
downloads this bundle, and applies it on its own. `install.sh` exists for first tries, one-off
boxes, and any environment without such a deployer in front of the bucket.

## Config and secrets

Real configuration and secrets are **not** part of this bundle — they're applied separately, from
the deployer's own filesystem or secret store, at deploy time. If this bundle includes
`k8s/configmap.example.yaml` or `k8s/secret.example.yaml`, treat them as references only: copy the
keys you need into your deployer's config, not into the cluster directly.
