import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Compass,
  Layers,
  MoveRight,
  Rocket,
  Server,
  Settings,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Cluster, ServiceClusterSummary, ServiceListItem, WorkloadSummary } from "../../shared/types/api";
import { fmtTs } from "../../shared/utils/format";
import { AppButton } from "../atoms/AppButton";
import { Pill } from "../atoms/Pill";
import { Tag } from "../atoms/Tag";
import { t } from "../../shared/i18n/t";

export interface ServiceActions {
  onDeploy: (name: string) => void;
  onEnv: (name: string, kind: "config" | "secret") => void;
  onHistory: (name: string) => void;
  onSettings: (name: string) => void;
  onDetail: (name: string) => void;
}

export function ClusterCard({ cluster, onEdit, onCheck, onBrowseCrds }: { cluster: Cluster; onEdit: (id: string) => void; onCheck: (id: string) => void; onBrowseCrds: (id: string) => void }) {
  return (
    <article className="resource-row">
      <div className="resource-main">
        <span className="resource-icon"><Server size={18} /></span>
        <span className="resource-content">
          <span className="resource-title">
            <strong>{cluster.name}</strong>
            <HealthPill health={cluster.health} />
            <SkewPill skew={cluster.versionSkew} />
            <Pill tone="acc">{cluster.runtime}</Pill>
          </span>
          <span className="resource-facts">
            <Fact label={t("ID")}><code>{cluster.id}</code></Fact>
            <Fact label={t("Namespace")}><code>{cluster.defaultNamespace}</code></Fact>
            <Fact label={t("Services")}>{cluster.serviceCount}</Fact>
            <Fact label={t("Last check")}>{cluster.health?.checkedAt ? fmtTs(cluster.health.checkedAt) : t("Never")}</Fact>
          </span>
          {cluster.health?.message && !cluster.health.ok ? <span className="resource-message">{cluster.health.message}</span> : null}
        </span>
      </div>
      <div className="resource-actions">
        <AppButton variant="ghost" onClick={() => onCheck(cluster.id)}><Activity size={15} />{t("Check")}</AppButton>
        <AppButton variant="ghost" onClick={() => onBrowseCrds(cluster.id)}><Boxes size={15} />{t("Custom resources")}</AppButton>
        <AppButton variant="ghost" onClick={() => onEdit(cluster.id)}><Settings size={15} />{t("Edit")}</AppButton>
      </div>
    </article>
  );
}

export function ServiceCard({ service, clusterLabel, actions }: { service: ServiceListItem; clusterLabel: (id: string) => string; actions: ServiceActions }) {
  const sourceDetail = service.sourceType === "r2-bundle"
    ? `R2: ${service.r2Prefix}`
    : service.sourceType === "git-sync"
    ? `Git: ${service.gitUrl} @ ${service.gitRef}`
    : `${service.imageRef}${service.imagePullSecret ? ` · Pull secret: ${service.imagePullSecret}` : ""}`;

  return (
    <article className="resource-row">
      <button className="resource-main" type="button" onClick={() => actions.onDetail(service.name)}>
        <span className="resource-icon"><Layers size={18} /></span>
        <span className="resource-content">
          <span className="resource-title">
            <strong>{service.name}</strong>
            <ClusterPill cluster={service.cluster} />
            {service.newVersion ? <Pill tone="warn">{t("Update")} {service.newVersion}</Pill> : null}
          </span>
          <span className="resource-facts">
            <Fact label={t("Cluster")}><Pill tone="acc" title={`Cluster id: ${service.clusterId}`}>{clusterLabel(service.clusterId)}</Pill></Fact>
            <Fact label={t("Namespace")}>{service.namespace}</Fact>
            <Fact label={t("Source")}>{service.sourceType === "r2-bundle" ? t("R2 bundle") : service.sourceType === "git-sync" ? t("Git repo") : t("Registry pull")}</Fact>
            <Fact label={t("Version")}>{service.currentTag ? <Tag>{service.currentTag}</Tag> : t("Not deployed")}</Fact>
          </span>
          <span className="resource-source">{sourceDetail}</span>
        </span>
      </button>
      <div className="resource-actions">
        <AppButton variant="ghost" onClick={() => actions.onDetail(service.name)}>{t("Details")} <MoveRight size={15} /></AppButton>
        <AppButton onClick={() => actions.onDeploy(service.name)}><Rocket size={15} />{t("Deploy")}</AppButton>
      </div>
    </article>
  );
}

export function UnmanagedCard({ workload, clusterLabel, onAdopt }: { workload: WorkloadSummary; clusterLabel: (id: string) => string; onAdopt: (workload: WorkloadSummary) => void }) {
  const container = workload.containers[0];
  return (
    <article className="resource-row">
      <div className="resource-main">
        <span className="resource-icon"><Compass size={18} /></span>
        <span className="resource-content">
          <span className="resource-title">
            <strong>{workload.name}</strong>
            <span className="resource-kind">{workload.kind}</span>
            <Pill tone={workload.readyReplicas === workload.replicas && workload.replicas > 0 ? "ok" : "warn"}>{workload.readyReplicas}/{workload.replicas} {t("ready")}</Pill>
          </span>
          <span className="resource-facts">
            <Fact label={t("Cluster")}><Pill tone="acc" title={`Cluster id: ${workload.clusterId}`}>{clusterLabel(workload.clusterId)}</Pill></Fact>
            <Fact label={t("Namespace")}>{workload.namespace}</Fact>
            <Fact label={t("Container")}><code>{container?.name || "?"}</code></Fact>
            <Fact label={t("Image")}><span className="technical-value">{container?.image || t("Unavailable")}</span></Fact>
          </span>
        </span>
      </div>
      <div className="resource-actions">
        <AppButton onClick={() => onAdopt(workload)}>{t("Adopt")}</AppButton>
      </div>
    </article>
  );
}

export function EmptyCard({ title, children }: { title: string; children: string }) {
  return (
    <div className="empty-state">
      <Compass size={22} />
      <div><strong>{title}</strong><span>{children}</span></div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <span className="resource-fact"><span>{label}</span><strong>{children}</strong></span>;
}

export function HealthPill({ health }: { health?: { ok: boolean; reachable: boolean } }) {
  if (!health) return <Pill tone="warn"><AlertTriangle size={12} />{t("Health unknown")}</Pill>;
  if (health.ok) return <Pill tone="ok"><CheckCircle2 size={12} />{t("Reachable")}</Pill>;
  if (health.reachable) return <Pill tone="warn"><AlertTriangle size={12} />{t("Degraded")}</Pill>;
  return <Pill tone="bad"><XCircle size={12} />{t("Unreachable")}</Pill>;
}

/** kubectl<->apiserver version skew warning (CC.5). Renders nothing when within the supported range. */
export function SkewPill({ skew }: { skew?: Cluster["versionSkew"] }) {
  if (!skew || skew.ok) return null;
  return <Pill tone="warn" title={skew.reason ?? undefined}><AlertTriangle size={12} />{t("Version skew")}</Pill>;
}

export function ClusterPill({ cluster }: { cluster: ServiceClusterSummary | null }) {
  if (!cluster) return <Pill tone="warn"><AlertTriangle size={12} />{t("Not found in cluster")}</Pill>;
  const tone = cluster.readyReplicas === cluster.replicas && cluster.replicas > 0 ? "ok" : cluster.replicas === 0 ? "warn" : "bad";
  const StatusIcon = tone === "ok" ? CheckCircle2 : tone === "warn" ? AlertTriangle : XCircle;
  return <Pill tone={tone}><StatusIcon size={12} />{cluster.readyReplicas}/{cluster.replicas} {t("ready")}</Pill>;
}
