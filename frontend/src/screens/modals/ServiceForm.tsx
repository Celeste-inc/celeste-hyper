import { useEffect, useState } from "react";
import type { Cluster, R2Source, WorkloadKind } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import type { ModalActions } from "../types";

const workloadKinds: WorkloadKind[] = ["Deployment", "StatefulSet", "DaemonSet"];

export function ServiceForm({ clusters, notify, closeModal, load }: ModalActions & { clusters: Cluster[] }) {
  const [sourceType, setSourceType] = useState<"r2-bundle" | "registry-pull" | "git-sync">("r2-bundle");
  const [name, setName] = useState("");
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? "");
  const [namespace, setNamespace] = useState(clusters[0]?.defaultNamespace ?? "default");
  const [r2Sources, setR2Sources] = useState<R2Source[]>([]);
  const [r2SourceId, setR2SourceId] = useState("default");
  const [r2Prefix, setR2Prefix] = useState("");
  const [imageRef, setImageRef] = useState("");
  const [workloadKind, setWorkloadKind] = useState<WorkloadKind>("Deployment");
  const [workloadName, setWorkloadName] = useState("");
  const [containerName, setContainerName] = useState("");
  const [imagePullSecret, setImagePullSecret] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitPath, setGitPath] = useState("");
  const [deployKeyPath, setDeployKeyPath] = useState("");

  useEffect(() => {
    void http.r2Sources().then((result) => {
      const items = result.body.items || [];
      setR2Sources(items);
      setR2SourceId((current) => current || items[0]?.id || "default");
    });
  }, []);

  const save = async () => {
    if (!clusterId) {
      notify(t("Pick a cluster first"), "bad");
      return;
    }
    const body = sourceType === "r2-bundle"
      ? { sourceType, name, clusterId, namespace: namespace || "default", r2SourceId, r2Prefix: r2Prefix && !r2Prefix.endsWith("/") ? `${r2Prefix}/` : r2Prefix, enabled: true }
      : sourceType === "git-sync"
      ? { sourceType, name, clusterId, namespace: namespace || "default", enabled: true, gitUrl, gitRef: gitRef || "main", gitPath: gitPath || ".", ...(deployKeyPath ? { deployKeyPath } : {}) }
      : { sourceType, name, clusterId, namespace: namespace || "default", enabled: true, imageRef, workloadKind, workloadName: workloadName || undefined, containerName: containerName || undefined, imagePullSecret: imagePullSecret || undefined };
    const result = await http.createService(body);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    closeModal();
    notify(t("Service added"));
    await load();
  };

  return (
    <>
      <h2 className="dialog-title">{t("Add service")}</h2>
      <p className="dialog-description">{t("Register a new service and choose how its images are delivered.")}</p>
      <Field id="f-name" label={t("Service name")} value={name} placeholder={t("my-service")} autoFocus onChange={setName} />
      <SelectField id="f-cluster" label={t("Target cluster")} value={clusterId} options={clusters.map((item) => ({ value: item.id, label: `${item.name} (${item.id})` }))} onChange={(id) => selectCluster(clusters, id, setClusterId, setNamespace)} />
      <Field id="f-ns" label={t("Namespace")} value={namespace} placeholder={t("production")} onChange={setNamespace} />
      <SelectField id="f-src" label={t("Image source")} value={sourceType} options={[{ value: "r2-bundle", label: t("R2 bundle (.tar + manifests)") }, { value: "registry-pull", label: t("Registry pull") }, { value: "git-sync", label: t("Git repo (manifests)") }]} onChange={(value) => setSourceType(value as typeof sourceType)} />
      {sourceType === "r2-bundle" ? <><SelectField id="f-r2source" label={t("R2 source")} value={r2SourceId} options={r2SourceOptions(r2Sources)} onChange={setR2SourceId} /><Field id="f-r2prefix" label={t("R2 prefix")} value={r2Prefix} placeholder={t("my-service/")} hint={t("The prefix must end with a slash.")} onChange={setR2Prefix} /></> : sourceType === "git-sync" ? (
        <>
          <Field id="f-giturl" label={t("Git URL")} value={gitUrl} placeholder="https://github.com/acme/repo.git" hint={t("Required.")} onChange={setGitUrl} />
          <Field id="f-gitref" label={t("Git ref")} value={gitRef} placeholder={t("main")} onChange={setGitRef} />
          <Field id="f-gitpath" label={t("Git path")} value={gitPath} placeholder={t("k8s — repo-relative manifest dir")} onChange={setGitPath} />
          <Field id="f-gitkey" label={t("Deploy key path")} value={deployKeyPath} placeholder={t("filename under the server git-keys dir")} hint={t("Optional.")} onChange={setDeployKeyPath} />
        </>
      ) : (
        <>
          <Field id="f-imgref" label={t("Image reference")} value={imageRef} placeholder={t("registry.example.com/my-service")} onChange={setImageRef} />
          <SelectField id="f-kind" label={t("Workload kind")} value={workloadKind} options={workloadKinds.map((kind) => ({ value: kind, label: kind }))} onChange={(value) => setWorkloadKind(value as WorkloadKind)} />
          <Field id="f-workload" label={t("Workload name")} value={workloadName} hint={t("Leave blank to use the service name.")} onChange={setWorkloadName} />
          <Field id="f-container" label={t("Container name")} value={containerName} hint={t("Leave blank to use the service name.")} onChange={setContainerName} />
          <Field id="f-pull" label={t("Image pull secret")} value={imagePullSecret} placeholder={t("registry-pull")} hint={t("Optional.")} onChange={setImagePullSecret} />
        </>
      )}
      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton><AppButton onClick={save}>{t("Create service")}</AppButton></div>
    </>
  );
}

function r2SourceOptions(sources: R2Source[]) {
  if (sources.length === 0) return [{ value: "default", label: "default" }];
  return sources.map((source) => ({ value: source.id, label: `${source.name} (${source.bucket})` }));
}

function selectCluster(clusters: Cluster[], id: string, setClusterId: (id: string) => void, setNamespace: (namespace: string) => void) {
  setClusterId(id);
  const cluster = clusters.find((item) => item.id === id);
  if (cluster) setNamespace(cluster.defaultNamespace || "default");
}
