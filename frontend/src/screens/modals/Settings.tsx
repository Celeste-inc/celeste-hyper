import { useEffect, useState } from "react";
import type { R2Source, Service } from "../../shared/types/api";
import { http } from "../../shared/api/client";
import { apiError } from "../../shared/utils/format";
import { AppButton } from "../../components/atoms/AppButton";
import { Field, SelectField } from "../../components/atoms/Field";
import { Pill } from "../../components/atoms/Pill";
import type { ModalActions } from "../types";
import { t } from "../../shared/i18n/t";

export function Settings({ name, notify, closeModal, load }: ModalActions & { name: string }) {
  const [service, setService] = useState<Service | null>(null);
  const [namespace, setNamespace] = useState("");
  const [r2Sources, setR2Sources] = useState<R2Source[]>([]);
  const [r2SourceId, setR2SourceId] = useState("default");
  const [r2Prefix, setR2Prefix] = useState("");
  const [imageRef, setImageRef] = useState("");
  const [containerName, setContainerName] = useState("");
  const [imagePullSecret, setImagePullSecret] = useState("");
  const [autoRollback, setAutoRollback] = useState(false);
  const [helmRelease, setHelmRelease] = useState("");
  const [helmChartRef, setHelmChartRef] = useState("");
  const [helmImageTagValuePath, setHelmImageTagValuePath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitPath, setGitPath] = useState("");
  const [deployKeyPath, setDeployKeyPath] = useState("");

  useEffect(() => {
    void http.r2Sources().then((result) => setR2Sources(result.body.items || []));
    void http.service(name).then((result) => {
      const item = result.body.service;
      if (!item) return;
      setService(item);
      setNamespace(item.namespace);
      setAutoRollback(Boolean(item.autoRollback));
      if (item.sourceType === "r2-bundle") {
        setR2SourceId(item.r2SourceId || "default");
        setR2Prefix(item.r2Prefix);
      }
      if (item.sourceType === "registry-pull") {
        setImageRef(item.imageRef);
        setContainerName(item.containerName || "");
        setImagePullSecret(item.imagePullSecret || "");
        setHelmRelease(item.helmRelease || "");
        setHelmChartRef(item.helmChartRef || "");
        setHelmImageTagValuePath(item.helmImageTagValuePath || "");
      }
      if (item.sourceType === "git-sync") {
        setGitUrl(item.gitUrl);
        setGitRef(item.gitRef);
        setGitPath(item.gitPath);
        setDeployKeyPath(item.deployKeyPath || "");
      }
    });
  }, [name]);

  if (!service) return <><h2 className="dialog-title">{name} {t("settings")}</h2><p className="text-[var(--mut)]">{t("Loading...")}</p></>;

  const save = async () => {
    const patch = service.sourceType === "r2-bundle"
      ? { sourceType: service.sourceType, namespace, r2SourceId, r2Prefix }
      : service.sourceType === "git-sync"
      ? { sourceType: service.sourceType, namespace, gitUrl, gitRef, gitPath, deployKeyPath: deployKeyPath || undefined }
      : { sourceType: service.sourceType, namespace, imageRef, containerName: containerName || undefined, imagePullSecret: imagePullSecret || undefined, autoRollback, helmRelease: helmRelease || undefined, helmChartRef: helmChartRef || undefined, helmImageTagValuePath: helmImageTagValuePath || undefined };
    const result = await http.updateService(name, patch);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    closeModal();
    notify(t("Changes saved"));
    await load();
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${name} from Celeste Hyper? Cluster resources will not be changed.`)) return;
    const result = await http.deleteService(name);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    closeModal();
    notify(t("Service removed"));
    await load();
  };

  return (
    <>
      <h2 className="dialog-title">{name} {t("settings")}</h2>
      <p className="dialog-description"><Pill tone="acc">{service.sourceType}</Pill></p>
      <Field id="e-ns" label={t("Namespace")} value={namespace} onChange={setNamespace} />
      {service.sourceType === "r2-bundle" ? <><SelectField id="e-r2source" label={t("R2 source")} value={r2SourceId} options={r2SourceOptions(r2Sources)} onChange={setR2SourceId} /><Field id="e-r2" label={t("R2 prefix")} value={r2Prefix} onChange={setR2Prefix} /></> : service.sourceType === "git-sync" ? (
        <>
          <Field id="e-giturl" label={t("Git URL")} value={gitUrl} onChange={setGitUrl} />
          <Field id="e-gitref" label={t("Git ref")} value={gitRef} onChange={setGitRef} />
          <Field id="e-gitpath" label={t("Git path")} value={gitPath} placeholder={t("k8s — repo-relative manifest dir")} onChange={setGitPath} />
          <Field id="e-gitkey" label={t("Deploy key path")} value={deployKeyPath} placeholder={t("filename under the server git-keys dir")} onChange={setDeployKeyPath} />
        </>
      ) : (
        <>
          <Field id="e-imgref" label={t("Image reference")} value={imageRef} onChange={setImageRef} />
          <Field id="e-container" label={t("Container name")} value={containerName} onChange={setContainerName} />
          <Field id="e-pull" label={t("Image pull secret")} value={imagePullSecret} onChange={setImagePullSecret} />
          <Field id="e-helmrel" label={t("Helm release")} value={helmRelease} onChange={setHelmRelease} />
          <Field id="e-helmchart" label={t("Helm chart ref")} value={helmChartRef} onChange={setHelmChartRef} />
          <Field id="e-helmpath" label={t("Helm image-tag values path")} value={helmImageTagValuePath} placeholder={t("image.tag or app.image.tag")} onChange={setHelmImageTagValuePath} />
          <label className="settings-check" htmlFor="e-autorollback">
            <input id="e-autorollback" type="checkbox" checked={autoRollback} onChange={(e) => setAutoRollback(e.target.checked)} />
            <span>{t("Auto-rollback on a failed health gate")}<br /><span className="text-[11px] text-[var(--mut)]">{t("When a deploy fails its health gate, automatically roll back to the previous version after a short grace window.")}</span></span>
          </label>
        </>
      )}
      <div className="dialog-actions justify-between"><AppButton variant="danger" onClick={remove}>{t("Remove service")}</AppButton><div className="flex gap-2"><AppButton variant="ghost" onClick={closeModal}>{t("Cancel")}</AppButton><AppButton onClick={save}>{t("Save changes")}</AppButton></div></div>
    </>
  );
}

function r2SourceOptions(sources: R2Source[]) {
  if (sources.length === 0) return [{ value: "default", label: "default" }];
  return sources.map((source) => ({ value: source.id, label: `${source.name} (${source.bucket})` }));
}
