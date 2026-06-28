import { useState } from "react";
import type { Cluster, RuntimeKind } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { HealthPill } from "../../components/organisms/Cards";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";

const runtimes: RuntimeKind[] = ["auto", "k3s", "docker", "containerd"];

export function ClusterForm({ mode, cluster, prefill, notify, closeModal, load }: ModalActions & { mode: "create" | "edit"; cluster?: Cluster; prefill?: { name?: string; notes?: string } }) {
  const [id, setId] = useState(cluster?.id ?? "");
  const [name, setName] = useState(cluster?.name ?? (mode === "create" ? prefill?.name ?? "" : ""));
  const [kubeconfigPath, setKubeconfigPath] = useState(cluster?.kubeconfigPath ?? "");
  const [defaultNamespace, setDefaultNamespace] = useState(cluster?.defaultNamespace ?? "default");
  const [runtime, setRuntime] = useState<RuntimeKind>(cluster?.runtime ?? "auto");

  if (mode === "edit" && !cluster) return <><h2>{t("Cluster not found")}</h2><p className="text-[var(--bad)]">{t("The selected cluster no longer exists.")}</p></>;

  const save = async () => {
    if (!id || !name) {
      notify(t("Id and display name are required"), "bad");
      return;
    }
    const body = { id, name, kubeconfigPath, defaultNamespace: defaultNamespace || "default", runtime, enabled: true };
    const result = mode === "create"
      ? await http.createCluster(body)
      : await http.updateCluster(id, { name, kubeconfigPath, defaultNamespace: defaultNamespace || "default", runtime, enabled: true });
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    closeModal();
    notify(mode === "create" ? t("Cluster added") : t("Cluster updated"));
    await load();
  };

  const remove = async () => {
    if (!cluster || !window.confirm(`Remove cluster ${cluster.id}? Services attached to it block removal.`)) return;
    const result = await http.deleteCluster(cluster.id);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    closeModal();
    notify(t("Cluster removed"));
    await load();
  };

  return (
    <>
      <h2 className="dialog-title">{mode === "create" ? t("Add cluster") : `${cluster?.name} settings`}</h2>
      <p className="dialog-description">{mode === "create" ? t("Register a Kubernetes cluster Celeste Hyper can deploy to.") : <span className="flex flex-wrap items-center gap-2">{cluster?.id}<HealthPill health={cluster?.health} /></span>}</p>
      {mode === "create" && prefill?.notes ? <p className="dialog-description">{t("Discovered endpoint:")} {prefill.notes}</p> : null}
      <Field id="cl-id" label={t("Cluster id")} value={id} readOnly={mode === "edit"} autoFocus={mode === "create"} placeholder={t("prod-vm1")} hint={t("Lowercase, letters/digits/dot/dash. Immutable after creation.")} onChange={setId} />
      <Field id="cl-name" label={t("Display name")} value={name} placeholder={t("Production VM 1")} onChange={setName} />
      <Field id="cl-kc" label={t("Kubeconfig path")} value={kubeconfigPath} placeholder={t("/etc/celeste-hyper/clusters/prod-vm1.kubeconfig")} hint={t("Path on the Celeste Hyper host. It must contain a reachable server URL.")} onChange={setKubeconfigPath} />
      <Field id="cl-ns" label={t("Default namespace")} value={defaultNamespace} onChange={setDefaultNamespace} />
      <SelectField id="cl-rt" label={t("Runtime")} value={runtime} options={runtimes.map((item) => ({ value: item, label: item }))} hint={t("Used for image import; auto-detects when set to auto.")} onChange={(value) => setRuntime(value as RuntimeKind)} />
      <div className="dialog-actions justify-between">
        {mode === "edit" ? <AppButton variant="danger" onClick={remove}>{t("Remove cluster")}</AppButton> : <span />}
        <div className="flex flex-wrap gap-2"><AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton><AppButton onClick={save}>{mode === "create" ? t("Add cluster") : t("Save changes")}</AppButton></div>
      </div>
    </>
  );
}
