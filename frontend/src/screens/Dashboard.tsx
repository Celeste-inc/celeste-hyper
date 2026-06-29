import { useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowUpRight, Boxes, CheckCircle2, ChevronDown, Compass, KeyRound, LayoutTemplate, Layers, Plus, Server, TriangleAlert } from "lucide-react";
import type { Cluster, ServiceListItem, WorkloadSummary } from "../shared/types/api";
import { t } from "../shared/i18n/t";
import { AppButton } from "../components/atoms/AppButton";
import { Pill } from "../components/atoms/Pill";
import { ClusterCard, EmptyCard, ServiceCard, UnmanagedCard, type ServiceActions } from "../components/organisms/Cards";
import { NamespaceFilter, readNamespacesFromUrl, writeNamespacesToUrl, filterByNamespace } from "../components/molecules/NamespaceFilter";

type DashboardView = "overview" | "services" | "discoveries";

interface DashboardProps {
  clusters: Cluster[];
  services: ServiceListItem[];
  unmanaged: WorkloadSummary[];
  clusterLabel: (id: string) => string;
  actions: ServiceActions;
  onAddCluster: () => void;
  onEditCluster: (id: string) => void;
  onCheckCluster: (id: string) => void;
  onBrowseCrds: (id: string) => void;
  onAddService: () => void;
  onBrowseTemplates: () => void;
  onManageRegistries: () => void;
  onAdopt: (workload: WorkloadSummary) => void;
  infrastructure: WorkloadSummary[];
  onReclassify: (workload: WorkloadSummary, category: "application" | "infrastructure") => void;
}

export function Dashboard(props: DashboardProps) {
  const [view, setView] = useState<DashboardView>("overview");
  const [namespaces, setNamespaces] = useState<string[]>(() => readNamespacesFromUrl());
  const onNamespacesChange = (next: string[]) => {
    setNamespaces(next);
    writeNamespacesToUrl(next);
  };
  const allNamespaces = useMemo(
    () =>
      [
        ...new Set([
          ...props.services.map((s) => s.namespace),
          ...props.unmanaged.map((w) => w.namespace),
          ...props.infrastructure.map((w) => w.namespace),
        ]),
      ].sort(),
    [props.services, props.unmanaged, props.infrastructure],
  );
  // Intersect the (URL-persisted) selection with what's currently available, so a stale namespace
  // that no longer exists can't silently filter everything to empty.
  const effectiveNs = useMemo(() => namespaces.filter((n) => allNamespaces.includes(n)), [namespaces, allNamespaces]);
  const services = useMemo(() => filterByNamespace(props.services, effectiveNs), [props.services, effectiveNs]);
  const unmanaged = useMemo(() => filterByNamespace(props.unmanaged, effectiveNs), [props.unmanaged, effectiveNs]);
  const infrastructure = useMemo(() => filterByNamespace(props.infrastructure, effectiveNs), [props.infrastructure, effectiveNs]);
  const [showInfra, setShowInfra] = useState(false);
  const summary = useMemo(() => {
    const healthyClusters = props.clusters.filter((cluster) => cluster.health?.ok).length;
    const readyServices = props.services.filter((service) => service.cluster && service.cluster.replicas > 0 && service.cluster.readyReplicas === service.cluster.replicas).length;
    const updates = props.services.filter((service) => service.newVersion).length;
    return { healthyClusters, readyServices, updates };
  }, [props.clusters, props.services]);

  return (
    <main className="app-main">
      <section className="page-heading">
        <div>
          <p className="eyebrow">{t("Operations")}</p>
          <h2>{t("Control plane")}</h2>
          <p>{t("Monitor infrastructure, manage services, and ship releases.")}</p>
        </div>
        <div className="page-actions">
          <AppButton variant="ghost" onClick={props.onAddCluster}><Server size={15} />{t("Add cluster")}</AppButton>
          <AppButton variant="ghost" onClick={props.onBrowseTemplates}><LayoutTemplate size={15} />{t("Templates")}</AppButton>
          <AppButton variant="ghost" onClick={props.onManageRegistries}><KeyRound size={15} />{t("Registries")}</AppButton>
          <AppButton onClick={props.onAddService}><Plus size={15} />{t("Add service")}</AppButton>
        </div>
      </section>

      <section className="summary-grid" aria-label={t("Control plane summary")}>
        <SummaryItem icon={<Server size={18} />} label={t("Clusters")} value={props.clusters.length} detail={`${summary.healthyClusters} reachable`} tone={props.clusters.length > 0 && summary.healthyClusters === props.clusters.length ? "ok" : "neutral"} />
        <SummaryItem icon={<Layers size={18} />} label={t("Services")} value={props.services.length} detail={`${summary.readyServices} ready`} tone={props.services.length > 0 && summary.readyServices === props.services.length ? "ok" : "neutral"} />
        <SummaryItem icon={<Activity size={18} />} label={t("Updates")} value={summary.updates} detail={summary.updates ? t("attention required") : t("up to date")} tone={summary.updates ? "warn" : "ok"} />
        <SummaryItem icon={<Compass size={18} />} label={t("Discoveries")} value={props.unmanaged.length} detail={props.unmanaged.length ? t("available to adopt") : t("nothing pending")} tone={props.unmanaged.length ? "warn" : "ok"} />
      </section>

      <nav className="view-tabs" aria-label={t("Dashboard views")}>
        <ViewTab active={view === "overview"} icon={<Boxes size={15} />} label={t("Overview")} onClick={() => setView("overview")} />
        <ViewTab active={view === "services"} icon={<Layers size={15} />} label={t("Services")} count={props.services.length} onClick={() => setView("services")} />
        <ViewTab active={view === "discoveries"} icon={<Compass size={15} />} label={t("Discoveries")} count={props.unmanaged.length} onClick={() => setView("discoveries")} />
      </nav>

      {view !== "overview" ? <NamespaceFilter namespaces={allNamespaces} selected={effectiveNs} onChange={onNamespacesChange} /> : null}

      {view === "overview" ? (
        <ResourceSection title={t("Clusters")} description={t("Kubernetes targets connected to this control plane.")} count={props.clusters.length}>
          {props.clusters.length === 0
            ? <EmptyCard title={t("No clusters configured")}>{t("Add a cluster to start managing services.")}</EmptyCard>
            : props.clusters.map((cluster) => <ClusterCard key={cluster.id} cluster={cluster} onEdit={props.onEditCluster} onCheck={props.onCheckCluster} onBrowseCrds={props.onBrowseCrds} />)}
        </ResourceSection>
      ) : null}

      {view === "services" ? (
        <ResourceSection title={t("Managed services")} description={t("Deployments registered and controlled by Celeste Hyper.")} count={services.length}>
          {services.length === 0
            ? <EmptyCard title={t("No managed services")}>{t("Add a service or adopt a discovered workload.")}</EmptyCard>
            : services.map((service) => <ServiceCard key={service.name} service={service} clusterLabel={props.clusterLabel} actions={props.actions} />)}
        </ResourceSection>
      ) : null}

      {view === "discoveries" ? (
        <ResourceSection title={t("Discovered workloads")} description={t("Cluster workloads that are not managed yet.")} count={unmanaged.length}>
          {unmanaged.length === 0
            ? <EmptyCard title={t("Everything is under control")}>{t("No unmanaged workloads were found.")}</EmptyCard>
            : unmanaged.map((workload) => <UnmanagedCard key={`${workload.clusterId}:${workload.namespace}:${workload.kind}:${workload.name}`} workload={workload} clusterLabel={props.clusterLabel} onAdopt={props.onAdopt} />)}
          {infrastructure.length > 0 ? (
            <div className="infra-section">
              <button type="button" className="infra-toggle" aria-expanded={showInfra} onClick={() => setShowInfra((v) => !v)}>
                <span className="infra-toggle-copy">
                  <span className={`infra-toggle-icon ${showInfra ? "open" : ""}`} aria-hidden="true"><ChevronDown size={15} /></span>
                  <span>
                    <strong>{t("Cluster infrastructure")}</strong>
                    <small>{t("System workloads kept out of the adoption queue unless you explicitly promote them.")}</small>
                  </span>
                </span>
                <span className="infra-toggle-meta">
                  <Pill tone="acc">{infrastructure.length} {infrastructure.length === 1 ? t("item") : t("items")}</Pill>
                </span>
              </button>
              {showInfra ? (
                <ul className="infra-list">
                  {infrastructure.map((workload) => (
                    <li className="infra-item" key={`${workload.clusterId}:${workload.namespace}:${workload.kind}:${workload.name}`}>
                      <div className="infra-item-copy">
                        <span className="infra-item-title">
                          <strong>{workload.name}</strong>
                          <span className="resource-kind">{workload.kind}</span>
                        </span>
                        <span className="infra-item-facts">
                          <Pill tone="acc" title={`Cluster id: ${workload.clusterId}`}>{props.clusterLabel(workload.clusterId)}</Pill>
                          <span>{workload.namespace}</span>
                        </span>
                      </div>
                      <AppButton className="infra-promote-button" variant="ghost" onClick={() => props.onReclassify(workload, "application")}>
                        {t("Move to applications")}
                        <ArrowUpRight size={14} />
                      </AppButton>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </ResourceSection>
      ) : null}
    </main>
  );
}

function SummaryItem({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: number; detail: string; tone: "ok" | "warn" | "neutral" }) {
  const StatusIcon = tone === "warn" ? TriangleAlert : tone === "ok" ? CheckCircle2 : Activity;
  return (
    <article className="summary-item">
      <span className="summary-icon">{icon}</span>
      <span className="summary-copy">
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
      <span className={`summary-detail ${tone}`}><StatusIcon size={13} />{detail}</span>
    </article>
  );
}

function ViewTab({ active, icon, label, count, onClick }: { active: boolean; icon: ReactNode; label: string; count?: number; onClick: () => void }) {
  return (
    <button className={`view-tab ${active ? "active" : ""}`} type="button" aria-current={active ? "page" : undefined} onClick={onClick}>
      {icon}<span>{label}</span>{count !== undefined ? <span className="view-count">{count}</span> : null}
    </button>
  );
}

function ResourceSection({ title, description, count, children }: { title: string; description: string; count: number; children: ReactNode }) {
  return (
    <section className="resource-section">
      <header className="resource-heading">
        <div><h3>{title}</h3><p>{description}</p></div>
        <span className="resource-count">{count}</span>
      </header>
      <div className="resource-list">{children}</div>
    </section>
  );
}
