import { useState } from "react";
import type { Cluster, WorkloadSummary } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError, imageRefWithoutTag } from "../../shared/utils/format";
import { t } from "../../shared/i18n/t";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import type { ModalActions } from "../types";

export function Adopt({ workload, clusters, notify, closeModal, load }: ModalActions & { workload: WorkloadSummary; clusters: Cluster[] }) {
  const firstContainer = workload.containers[0];
  const [name, setName] = useState(workload.name);
  const [clusterId, setClusterId] = useState(workload.clusterId);
  const [containerName, setContainerName] = useState(firstContainer?.name || workload.name);
  const [imageRef, setImageRef] = useState(imageRefWithoutTag(firstContainer?.image));
  const [imagePullSecret, setImagePullSecret] = useState("");

  const save = async () => {
    const result = await http.adoptService({ name, namespace: workload.namespace, clusterId, workloadKind: workload.kind, workloadName: workload.name, containerName, imageRef, imagePullSecret: imagePullSecret || undefined });
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    closeModal();
    notify(t("Workload adopted"));
    await load();
  };

  return (
    <>
      <h2 className="dialog-title">{t("Adopt")} {workload.kind}/{workload.name}</h2>
      <p className="dialog-description">{t("This creates a managed registry-pull service. Future deployments use")} <code>kubectl set image</code>.</p>
      <Field id="a-name" label={t("Service name")} value={name} autoFocus onChange={setName} />
      <SelectField id="a-cluster" label={t("Target cluster")} value={clusterId} options={clusters.map((item) => ({ value: item.id, label: `${item.name} (${item.id})` }))} onChange={setClusterId} />
      <Field id="a-ns" label={t("Namespace")} value={workload.namespace} readOnly onChange={() => undefined} />
      <Field id="a-kind" label={t("Workload kind")} value={workload.kind} readOnly onChange={() => undefined} />
      <Field id="a-workload" label={t("Workload name")} value={workload.name} readOnly onChange={() => undefined} />
      <Field id="a-container" label={t("Container name")} value={containerName} onChange={setContainerName} />
      <Field id="a-imgref" label={t("Image reference")} value={imageRef} hint={t("Enter the image reference without a tag.")} onChange={setImageRef} />
      <Field id="a-pull" label={t("Image pull secret")} value={imagePullSecret} placeholder={t("registry-pull")} hint={t("Optional.")} onChange={setImagePullSecret} />
      <div className="dialog-actions"><AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton><AppButton onClick={save}>{t("Adopt workload")}</AppButton></div>
    </>
  );
}
