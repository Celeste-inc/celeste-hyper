import { Fragment, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpCircle,
  Box,
  CheckCircle2,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  FileCode2,
  Gauge,
  Globe2,
  History,
  KeyRound,
  LayoutDashboard,
  ListTree,
  Network,
  Pause,
  Play,
  Rocket,
  Search,
  Settings,
  SquareTerminal,
  Trash2,
  Undo2,
  WrapText,
  X,
} from "lucide-react";
import type { AutoRollbackStatus, Deployment, Endpoint, HelmInfo, HpaView, K8sEvent, NetworkingService, PodSummary, Service, ServiceListItem } from "../shared/types/api";
import { http } from "../shared/api/client";
import { apiError, fmtTs } from "../shared/utils/format";
import { t } from "../shared/i18n/t";
import { AppButton } from "../components/atoms/AppButton";
import { Field } from "../components/atoms/Field";
import { Pill } from "../components/atoms/Pill";
import { Tag } from "../components/atoms/Tag";
import { EnvPanels } from "../components/molecules/EnvPanels";
import { ClusterPill } from "../components/organisms/Cards";
import type { ModalState, Notify } from "./types";

interface ServiceDetailProps {
  name: string;
  services: ServiceListItem[];
  clusterLabel: (id: string) => string;
  notify: Notify;
  onClose: () => void;
  setModal: (modal: ModalState | null) => void;
  isObscured: boolean;
}

export function ServiceDetail({ name, services, clusterLabel, notify, onClose, setModal, isObscured }: ServiceDetailProps) {
  const [service, setService] = useState<Service | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [pods, setPods] = useState<PodSummary[]>([]);
  const [events, setEvents] = useState<K8sEvent[]>([]);
  const [selector, setSelector] = useState<string>();
  const [networking, setNetworking] = useState<NetworkingService | null>(null);
  const [canRollback, setCanRollback] = useState(false);
  const card = services.find((item) => item.name === name);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isObscured) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isObscured, onClose]);

  useEffect(() => {
    void Promise.all([http.service(name), http.deployments(name), http.pods(name), http.events(name), http.networking(name), http.rollbackPreview(name)]).then(
      ([serviceRes, depRes, podRes, evRes, netRes, rbRes]) => {
        setService(serviceRes.body.service || null);
        setDeployments((depRes.body.items || []).slice(0, 8));
        setPods(podRes.body.items || []);
        setEvents(evRes.body.items || []);
        setSelector(podRes.body.selector);
        setNetworking(netRes.body.service || null);
        setCanRollback(Boolean(rbRes.body.eligible));
      },
    );
  }, [name]);

  const openModal = (modal: ModalState) => setModal(modal);

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="detail-sheet" role="dialog" aria-modal={!isObscured} aria-hidden={isObscured || undefined} aria-label={`${name} service details`}>
        <button className="hyper-button ghost sheet-close" type="button" aria-label={t("Close service details")} onClick={onClose}><X size={18} /></button>
        {!service ? (
          <ServiceDetailSkeleton name={name} card={card} clusterLabel={clusterLabel} />
        ) : (
          <ServiceDetailContent service={service} card={card} deployments={deployments} pods={pods} events={events} selector={selector} networking={networking} clusterLabel={clusterLabel} notify={notify} openModal={openModal} canRollback={canRollback} />
        )}
      </aside>
    </div>
  );
}

function ServiceDetailContent({ service, card, deployments, pods, events, selector, networking, clusterLabel, notify, openModal, canRollback }: {
  service: Service;
  card?: ServiceListItem;
  deployments: Deployment[];
  pods: PodSummary[];
  events: K8sEvent[];
  selector?: string;
  networking: NetworkingService | null;
  clusterLabel: (id: string) => string;
  notify: Notify;
  openModal: (modal: ModalState) => void;
  canRollback: boolean;
}) {
  const name = service.name;
  const env = card?.env || { config: { exists: false, keys: [], path: "" }, secret: { exists: false, keys: [], path: "" } };
  const [activeView, setActiveView] = useState<"overview" | "runtime" | "configuration">("overview");
  const totalRestarts = pods.reduce((total, pod) => total + pod.containers.reduce((sum, container) => sum + (container.restartCount || 0), 0), 0);
  const unhealthyPods = pods.filter((pod) => podStatusPill(pod).tone === "bad");
  const warningEvents = events.filter((event) => event.type === "Warning");
  const endpoints = getEndpoints(networking);
  const workloadReady = Boolean(card?.cluster && card.cluster.replicas > 0 && card.cluster.readyReplicas === card.cluster.replicas);

  return (
    <div className="service-detail">
      <header className="service-detail-header">
        <div className="service-detail-identity">
          <div className={`service-health-mark ${workloadReady ? "ok" : "bad"}`} aria-hidden="true">
            {workloadReady ? <CheckCircle2 size={24} /> : <AlertTriangle size={24} />}
          </div>
          <div className="service-detail-heading">
            <span className="service-eyebrow">{t("Managed service")}</span>
            <div className="service-title-line">
              <h2>{name}</h2>
              <ClusterPill cluster={card?.cluster ?? null} />
            </div>
            <p>
              <span>{t("Namespace")} <code>{service.namespace}</code></span>
              <span aria-hidden="true">•</span>
              <span>{clusterLabel(service.clusterId)}</span>
              <span aria-hidden="true">•</span>
              <span>{t("Registered in Celeste Hyper")}</span>
            </p>
          </div>
        </div>
        <div className="detail-toolbar">
          <AppButton onClick={() => openModal({ type: "deploy", name })}><Rocket size={15} />{t("Deploy")}</AppButton>
          {canRollback ? <AppButton variant="ghost" onClick={() => openModal({ type: "rollback", name })}><Undo2 size={15} />{t("Rollback")}</AppButton> : null}
          <AppButton variant="ghost" onClick={() => openModal({ type: "service-settings", name })}><Settings size={15} />{t("Settings")}</AppButton>
          <AppButton variant="ghost" onClick={() => openModal({ type: "history", name })}><History size={15} />{t("History")}</AppButton>
        </div>
      </header>

      <AutoRollbackBanner name={name} notify={notify} />

      <div className="service-vitals" aria-label={t("Service health summary")}>
        <ServiceVital icon={<Box size={17} />} label={t("Workload")} tone={workloadReady ? "ok" : "bad"} value={card?.cluster ? `${card.cluster.readyReplicas} / ${card.cluster.replicas} ${t("ready")}` : t("Not found")} />
        <ServiceVital icon={<CircleDot size={17} />} label={t("Pods")} tone={unhealthyPods.length ? "bad" : pods.length ? "ok" : "warn"} value={unhealthyPods.length ? `${unhealthyPods.length} ${t("unhealthy")}` : `${pods.length} ${t("total")}`} />
        <ServiceVital icon={<Activity size={17} />} label={t("Restarts")} tone={totalRestarts ? "bad" : "ok"} value={String(totalRestarts)} />
        <ServiceVital icon={<Network size={17} />} label={t("Endpoints")} tone={endpoints.length ? "acc" : "warn"} value={String(endpoints.length)} />
      </div>

      <nav className="service-view-switcher" aria-label={t("Service detail views")}>
        <ServiceViewButton active={activeView === "overview"} icon={<LayoutDashboard size={15} />} onClick={() => setActiveView("overview")}>{t("Overview")}</ServiceViewButton>
        <ServiceViewButton active={activeView === "runtime"} icon={<Activity size={15} />} badge={warningEvents.length || undefined} onClick={() => setActiveView("runtime")}>{t("Runtime")}</ServiceViewButton>
        <ServiceViewButton active={activeView === "configuration"} icon={<Settings size={15} />} onClick={() => setActiveView("configuration")}>{t("Configuration")}</ServiceViewButton>
      </nav>

      {activeView === "overview" ? (
        <div className="detail-layout">
          <div className="detail-column">
            <DetailSection icon={<LayoutDashboard size={16} />} title={t("Overview")}>
              <Kv rows={[[t("Current tag"), card?.currentTag ? <Tag>{card.currentTag}</Tag> : null], [t("Cluster"), <Pill tone="acc" title={`Cluster id: ${service.clusterId}`}>{clusterLabel(service.clusterId)}</Pill>], [t("Deployed at"), card?.deployedAt ? fmtTs(card.deployedAt) : null], [t("Cluster status"), <ClusterPill cluster={card?.cluster ?? null} />], [t("Update available"), card?.newVersion ? <Pill tone="warn">{card.newVersion}</Pill> : null]]} />
            </DetailSection>
            <DetailSection icon={<Box size={16} />} title={t("Cluster")}>
              {card?.cluster ? <><Kv rows={[[t("Kind"), <Tag>{card.cluster.kind}</Tag>], [t("Replicas"), `${card.cluster.readyReplicas} / ${card.cluster.replicas} ready`]]} /><h4 className="detail-subtitle">{t("Containers")}</h4><ul className="detail-list">{card.cluster.containers.map((container) => <li key={container.name}><Tag>{container.name}</Tag><span>{t("to")}</span><Tag>{container.image}</Tag></li>)}</ul></> : <p className="detail-empty">{t("No matching workload found in the cluster.")}</p>}
            </DetailSection>
            <AutoscalingPanel name={name} openModal={openModal} />
            <HelmPanel name={name} notify={notify} />
          </div>
          <div className="detail-column">
            <DetailSection icon={<Globe2 size={16} />} title={t("Open service")}><EndpointPanel service={networking} notify={notify} clusterId={service.clusterId} openModal={openModal} /></DetailSection>
            <DetailSection icon={<Network size={16} />} title={t("Networking")}>{networking ? <NetworkingInfo service={networking} /> : <p className="detail-empty">{t("No Kubernetes Service object was found in the namespace.")}</p>}</DetailSection>
            <DetailSection icon={<FileCode2 size={16} />} title={t("Source")}><SourceDetail service={service} /></DetailSection>
          </div>
        </div>
      ) : null}

      {activeView === "runtime" ? (
        <div className="runtime-layout">
          {unhealthyPods.length || warningEvents.length ? (
            <div className="operations-alert" role="alert">
              <AlertTriangle size={20} />
              <div><strong>{t("Runtime needs attention")}</strong><span>{unhealthyPods.length} {t("unhealthy pods")} · {warningEvents.length} {t("warning events")} · {totalRestarts} {t("container restarts")}</span></div>
            </div>
          ) : null}
          <DetailSection icon={<Box size={16} />} title={t("Pods")} meta={`${pods.length} ${t("total")}`}>
            {pods.length ? <PodsTable name={name} pods={pods} openModal={openModal} /> : <p className="detail-empty">{t("No pods matched the workload selector")} ({selector || "-"}).</p>}
          </DetailSection>
          <DetailSection icon={<ListTree size={16} />} title={t("Events")} meta={warningEvents.length ? `${warningEvents.length} ${t("warnings")}` : undefined}>
            {events.length ? <EventsTable items={events} /> : <p className="detail-empty">{t("No recent events for pods backing this service.")}</p>}
          </DetailSection>
          <DetailSection icon={<SquareTerminal size={16} />} title={t("Live logs")}><LogsPanel serviceName={name} pods={pods} /></DetailSection>
          <DetailSection icon={<Clock3 size={16} />} title={t("Recent deployments")}>{deployments.length ? <DeploymentTable items={deployments} /> : <p className="detail-empty">{t("No deployments yet.")}</p>}</DetailSection>
        </div>
      ) : null}

      {activeView === "configuration" ? (
        <div className="configuration-layout">
          <div className="configuration-actions">
            <AppButton onClick={() => openModal({ type: "env", name, kind: "config" })}><FileCode2 size={15} />{t("Edit")} config.env</AppButton>
            <AppButton variant="ghost" onClick={() => openModal({ type: "env", name, kind: "secret" })}><KeyRound size={15} />{t("Edit")} secret.env</AppButton>
          </div>
          <DetailSection icon={<Settings size={16} />} title={t("Environment")}><EnvPanels env={env} /></DetailSection>
        </div>
      ) : null}
    </div>
  );
}

function ServiceVital({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: "ok" | "bad" | "warn" | "acc" }) {
  return <div className={`service-vital ${tone}`}><span className="service-vital-icon">{icon}</span><span><small>{label}</small><strong>{value}</strong></span></div>;
}

function ServiceDetailSkeleton({ name, card, clusterLabel }: { name: string; card?: ServiceListItem; clusterLabel: (id: string) => string }) {
  return (
    <div className="service-detail" aria-busy="true">
      <header className="service-detail-header">
        <div className="service-detail-identity">
          <div className="service-health-mark acc skeleton-pulse" aria-hidden="true"><Activity size={24} /></div>
          <div className="service-detail-heading">
            <span className="service-eyebrow">{t("Managed service")}</span>
            <div className="service-title-line">
              <h2>{name}</h2>
              {card?.cluster ? <ClusterPill cluster={card.cluster} /> : <span className="skeleton skeleton-pill" />}
            </div>
            <p>
              {card ? (
                <>
                  <span>{t("Namespace")} <code>{card.namespace}</code></span>
                  <span aria-hidden="true">•</span>
                  <span>{clusterLabel(card.clusterId)}</span>
                  <span aria-hidden="true">•</span>
                  <span className="text-[var(--mut)]">{t("Fetching live state…")}</span>
                </>
              ) : (
                <span className="skeleton skeleton-line skeleton-line-half" />
              )}
            </p>
          </div>
        </div>
        <div className="detail-toolbar" aria-hidden="true">
          <span className="skeleton skeleton-btn" />
          <span className="skeleton skeleton-btn skeleton-btn-ghost" />
          <span className="skeleton skeleton-btn skeleton-btn-ghost" />
        </div>
      </header>

      <div className="service-vitals" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div className="service-vital" key={i}>
            <span className="skeleton skeleton-vital-icon" />
            <span className="skeleton-vital-text">
              <span className="skeleton skeleton-line skeleton-line-xs" />
              <span className="skeleton skeleton-line skeleton-line-sm" />
            </span>
          </div>
        ))}
      </div>

      <nav className="service-view-switcher" aria-hidden="true">
        <span className="skeleton skeleton-tab" />
        <span className="skeleton skeleton-tab" />
        <span className="skeleton skeleton-tab" />
      </nav>

      <div className="detail-layout" aria-hidden="true">
        <div className="detail-column">
          <SkeletonSection rows={4} />
          <SkeletonSection rows={3} />
        </div>
        <div className="detail-column">
          <SkeletonSection rows={3} />
          <SkeletonSection rows={5} />
        </div>
      </div>
    </div>
  );
}

function SkeletonSection({ rows }: { rows: number }) {
  return (
    <section className="detail-section">
      <header>
        <div>
          <span className="skeleton skeleton-section-icon" />
          <span className="skeleton skeleton-line skeleton-line-title" />
        </div>
      </header>
      <div className="detail-section-body">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className={`skeleton skeleton-row ${i === rows - 1 ? "skeleton-row-last" : ""}`} />
        ))}
      </div>
    </section>
  );
}

function ServiceViewButton({ active, icon, badge, children, onClick }: { active: boolean; icon: ReactNode; badge?: number; children: ReactNode; onClick: () => void }) {
  return <button className={active ? "active" : ""} type="button" aria-current={active ? "page" : undefined} onClick={onClick}>{icon}<span>{children}</span>{badge ? <span className="service-view-badge" aria-hidden="true">{badge}</span> : null}</button>;
}

function AutoRollbackBanner({ name, notify }: { name: string; notify: Notify }) {
  const [status, setStatus] = useState<AutoRollbackStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void http.autoRollbackStatus(name).then((res) => {
        if (alive && res.status === 200) setStatus(res.body);
      });
    refresh();
    const poll = setInterval(refresh, 2000); // catch the worker's grace-window enqueue / clear
    const tick = setInterval(() => alive && setNow(Date.now()), 1000); // drive the countdown
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [name]);

  if (!status || (!status.pending && !status.degraded)) return null;

  const cancel = async () => {
    setBusy(true);
    const res = await http.cancelAutoRollback(name);
    setBusy(false);
    if (res.status >= 400) return notify(apiError(res.body, res.status), "bad");
    notify(t("Auto-rollback cancelled"));
    setStatus((s) => (s ? { ...s, pending: null } : s));
  };

  const clear = async () => {
    setBusy(true);
    const res = await http.undegrade(name);
    setBusy(false);
    if (res.status >= 400) return notify(apiError(res.body, res.status), "bad");
    notify(t("Deploys re-enabled"));
    setStatus((s) => (s ? { ...s, degraded: null } : s));
  };

  const remaining = status.pending ? Math.max(0, Math.ceil((new Date(status.pending.nextAttemptAt).getTime() - now) / 1000)) : 0;
  return (
    <>
      {status.pending ? (
        <div className="detail-banner warn" role="status">
          <span>{t("Health gate failed — automatic rollback")} {remaining > 0 ? `in ${remaining}s` : t("running…")}.</span>
          {remaining > 0 ? (
            <AppButton variant="ghost" disabled={busy} onClick={cancel}><X size={15} />{t("Cancel rollback")}</AppButton>
          ) : null}
        </div>
      ) : null}
      {status.degraded ? (
        <div className="detail-banner bad" role="alert">
          <span>{t("Service degraded:")} {status.degraded.reason}. {t("Deploys are blocked until re-enabled.")}</span>
          <AppButton variant="ghost" disabled={busy} onClick={clear}><Play size={15} />{t("Re-enable deploys")}</AppButton>
        </div>
      ) : null}
    </>
  );
}

function AutoscalingPanel({ name, openModal }: { name: string; openModal: (modal: ModalState) => void }) {
  const [hpa, setHpa] = useState<HpaView | null>(null);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    void http.hpa(name).then((res) => {
      setAvailable(res.status === 200); // 409 → capability absent → panel hidden
      setHpa(res.status === 200 ? res.body.hpa : null);
    });
  }, [name]);
  if (!available) return null;
  return (
    <DetailSection title={t("Autoscaling")}>
      {hpa ? (
        <>
          <Kv
            rows={[
              [t("Replicas"), `${hpa.currentReplicas ?? "?"} now · ${hpa.desiredReplicas ?? "?"} desired`],
              [t("Range"), `${hpa.minReplicas ?? "?"} – ${hpa.maxReplicas ?? "?"}`],
              [t("Target CPU"), hpa.targetCPUUtilizationPercentage != null ? `${hpa.targetCPUUtilizationPercentage}%` : "—"],
            ]}
          />
          <AppButton variant="ghost" onClick={() => openModal({ type: "hpa", name, hpa })}><Gauge size={15} />{t("Edit autoscaling")}</AppButton>
        </>
      ) : (
        <p className="text-[var(--mut)]">{t("No HorizontalPodAutoscaler targets this workload.")}</p>
      )}
    </DetailSection>
  );
}

function HelmPanel({ name, notify }: { name: string; notify: Notify }) {
  const [helm, setHelm] = useState<HelmInfo | null>(null);
  const [available, setAvailable] = useState(false);
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void http.helm(name).then((res) => {
      const info = res.status === 200 ? res.body.helm : null; // 409 → capability absent; null → not Helm-managed
      setAvailable(Boolean(info)); // either case → panel hidden
      setHelm(info);
    });
  }, [name]);
  if (!available || !helm) return null;

  const upgrade = async () => {
    setBusy(true);
    const res = await http.helmUpgrade(name, tag.trim());
    setBusy(false);
    if (res.status >= 400) return notify(apiError(res.body, res.status), "bad");
    notify(t("Helm upgrade enqueued"));
    setTag("");
  };

  return (
    <DetailSection title={t("Helm")}>
      <Kv
        rows={[
          [t("Release"), <Tag>{helm.release}</Tag>],
          [t("Namespace"), <Tag>{helm.namespace}</Tag>],
          [t("Chart"), helm.chart ? <Tag>{helm.chart}</Tag> : null],
          [t("Version"), helm.version ? <Tag>{helm.version}</Tag> : null],
        ]}
      />
      {helm.upgradeable ? (
        <>
          <Field id="helm-tag" label={t("Image tag")} value={tag} placeholder={t("v1.2.3 or commit SHA")} onChange={setTag} />
          <AppButton disabled={busy || !tag.trim()} onClick={upgrade}><ArrowUpCircle size={15} />{t("Upgrade")}</AppButton>
        </>
      ) : (
        <p className="text-[var(--mut)]">{t("Configure helmRelease, helmChartRef and helmImageTagValuePath in Settings to enable upgrades.")}</p>
      )}
      <h4 className="detail-subtitle">{t("Values")}</h4>
      <pre className="values-block">{JSON.stringify(helm.valuesRedacted, null, 2)}</pre>
    </DetailSection>
  );
}

function EndpointPanel({ service, notify, clusterId, openModal }: { service: NetworkingService | null; notify: Notify; clusterId: string; openModal: (modal: ModalState) => void }) {
  const endpoints = useMemo(() => getEndpoints(service), [service]);
  const hasServerEndpoints = Boolean(service?.endpoints?.length);

  if (!service) return <p className="text-[var(--mut)]">{t("No networking information is available for this service.")}</p>;
  if (endpoints.length === 0) return <p className="text-[var(--mut)]">{t("No accessible URL could be derived from the current Service ports.")}</p>;

  const copy = async (url: string) => {
    try {
      await copyText(url);
      notify(t("URL copied"));
    } catch {
      notify(t("Could not copy URL"), "bad");
    }
  };

  return (
    <>
      <div className="endpoint-panel">
        <div className="flex items-center gap-2"><Globe2 className="text-[var(--acc)]" size={20} /><strong>{t("Available endpoints")}</strong></div>
        <ul>
          {endpoints.map((endpoint) => (
            <li key={`${endpoint.kind}:${endpoint.url}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><Pill tone="acc">{endpoint.kind}</Pill><code className="endpoint-url">{endpoint.url}</code></div>
                <p>{endpoint.description}</p>
                {endpoint.dns ? <p className="text-xs text-[var(--mut)]">{endpoint.dns.resolved ? `DNS → ${endpoint.dns.addresses.join(", ")} (${endpoint.dns.elapsedMs}ms)` : `DNS: ${endpoint.dns.reason}`}</p> : null}
              </div>
              <div className="flex shrink-0 gap-2">
                {endpoint.source ? <button className="icon-button" type="button" aria-label={`View source of ingress ${endpoint.source.ingressName}`} onClick={() => openModal({ type: "ingress-yaml", clusterId, namespace: endpoint.source!.ingressNamespace, name: endpoint.source!.ingressName })}><FileCode2 size={16} /></button> : null}
                {endpoint.copyable ? <button className="icon-button" type="button" aria-label={`Copy ${endpoint.url}`} onClick={() => void copy(endpoint.url)}><Copy size={16} /></button> : null}
                <a className="icon-button" href={endpoint.url} target="_blank" rel="noreferrer" aria-label={`Open ${endpoint.url} in a new tab`}><ExternalLink size={16} /></a>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {!hasServerEndpoints && service.ports.some((port) => port.nodePort) ? <p className="mt-3 text-xs text-[var(--mut)]">{t("Best-effort fallback: NodePort is reachable at")} <code>&lt;host&gt;:&lt;nodePort&gt;</code>. {t("The host shown above uses the current browser hostname.")}</p> : null}
    </>
  );
}

async function copyText(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy command failed");
}

function getEndpoints(service: NetworkingService | null): Endpoint[] {
  if (!service) return [];
  if (service.endpoints?.length) return service.endpoints;
  const protocol = window.location.protocol === "https:" ? "https" : "http";
  const clusterEndpoints = service.clusterIP && service.clusterIP !== "None"
    ? service.ports.map((port) => ({ kind: "cluster-ip" as const, url: `${protocol}://${service.clusterIP}:${port.port}`, description: t("Reachable from within the cluster network."), copyable: true }))
    : [];
  const nodeEndpoints = service.ports.filter((port) => port.nodePort).map((port) => ({ kind: "node-port" as const, url: `${protocol}://${window.location.hostname}:${port.nodePort}`, description: t("Best-effort URL using the current control-plane hostname."), copyable: true }));
  return [...nodeEndpoints, ...clusterEndpoints];
}

function SourceDetail({ service }: { service: Service }) {
  if (service.sourceType === "r2-bundle") return <Kv rows={[[t("Source type"), <Pill tone="acc">{t("R2 bundle")}</Pill>], [t("R2 source"), <Tag>{service.r2SourceId || "default"}</Tag>], [t("R2 prefix"), <Tag>{service.r2Prefix}</Tag>], [t("Manifest root"), service.manifestRoot ? <Tag>{service.manifestRoot}</Tag> : null], [t("Image tar pattern"), service.imageTarPattern ? <Tag>{service.imageTarPattern}</Tag> : null], [t("Image ref prefix"), service.imageRefPrefix ? <Tag>{service.imageRefPrefix}</Tag> : null]]} />;
  if (service.sourceType === "git-sync") return <Kv rows={[[t("Source type"), <Pill tone="acc">{t("Git repo")}</Pill>], [t("Git URL"), <Tag>{service.gitUrl}</Tag>], [t("Git ref"), <Tag>{service.gitRef}</Tag>], [t("Git path"), <Tag>{service.gitPath}</Tag>], [t("Deploy key path"), service.deployKeyPath ? <Tag>{service.deployKeyPath}</Tag> : null]]} />;
  return <Kv rows={[[t("Source type"), <Pill tone="acc">{t("Registry pull")}</Pill>], [t("Image reference"), <Tag>{service.imageRef}</Tag>], [t("Workload kind"), <Tag>{service.workloadKind}</Tag>], [t("Workload name"), <Tag>{service.workloadName || service.name}</Tag>], [t("Container name"), <Tag>{service.containerName || service.name}</Tag>], [t("Image pull secret"), service.imagePullSecret ? <Tag>{service.imagePullSecret}</Tag> : null]]} />;
}

function LogsPanel({ serviceName, pods }: { serviceName: string; pods: PodSummary[] }) {
  const [pod, setPod] = useState(pods[0]?.name ?? "");
  const [container, setContainer] = useState(pods[0]?.containers[0]?.name ?? "");
  const [status, setStatus] = useState(t("Idle."));
  const [lines, setLines] = useState<{ text: string; kind: "stdout" | "stderr" }[]>([]);
  const [wrap, setWrap] = useState(true);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const streamRef = useRef<EventSource | null>(null);
  const startingRef = useRef(false);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const visibleLines = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return lines
      .map((line, index) => ({ ...line, lineNumber: index + 1 }))
      .filter((line) => !normalizedQuery || line.text.toLocaleLowerCase().includes(normalizedQuery));
  }, [lines, query]);

  useEffect(() => () => stopStream(streamRef), []);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && !paused) viewer.scrollTop = viewer.scrollHeight;
  }, [lines, paused]);
  useEffect(() => {
    const selectedPod = pods.find((item) => item.name === pod);
    if (!selectedPod?.containers.some((item) => item.name === container)) setContainer(selectedPod?.containers[0]?.name ?? "");
  }, [container, pod, pods]);

  if (pods.length === 0) return <p className="text-[var(--mut)]">{t("No pods available to stream logs from.")}</p>;

  const start = async () => {
    if (startingRef.current) return; // re-entrancy guard: rapid clicks must not leak a second stream
    startingRef.current = true;
    try {
      stopStream(streamRef);
      if (!pod) return;
      setPaused(false);
      setStatus(t("Streaming..."));
      // EventSource can't send an Authorization header, so mint a one-shot token (cookie+CSRF) first.
      const tokenRes = await http.logToken(serviceName);
      if (tokenRes.status !== 200 || !tokenRes.body.token) {
        setStatus(tokenRes.body.error ?? t("Failed to start stream"));
        return;
      }
      const url = `/api/services/${encodeURIComponent(serviceName)}/logs?logToken=${encodeURIComponent(tokenRes.body.token)}&pod=${encodeURIComponent(pod)}${container ? `&container=${encodeURIComponent(container)}` : ""}&tail=200`;
      const eventSource = new EventSource(url);
      streamRef.current = eventSource;
      const append = (text: string, kind: "stdout" | "stderr") => setLines((current) => [...current, { text, kind }].slice(-500));
      eventSource.addEventListener("stdout", (event) => append((event as MessageEvent<string>).data, "stdout"));
      eventSource.addEventListener("stderr", (event) => append((event as MessageEvent<string>).data, "stderr"));
      eventSource.addEventListener("end", (event) => {
        setStatus(`Stream ended (exit ${(event as MessageEvent<string>).data})`);
        stopStream(streamRef);
      });
      eventSource.onerror = () => {
        setStatus(t("Disconnected"));
        stopStream(streamRef);
      };
    } catch {
      setStatus(t("Failed to connect"));
    } finally {
      startingRef.current = false;
    }
  };

  const togglePause = () => {
    if (paused) {
      void start();
      return;
    }
    stopStream(streamRef);
    setPaused(true);
    setStatus(t("Paused."));
  };

  const copyLogs = async () => {
    if (!visibleLines.length) return;
    try {
      await copyText(visibleLines.map((line) => line.text).join("\n"));
      setStatus(t("Visible logs copied."));
    } catch {
      setStatus(t("Could not copy logs."));
    }
  };

  const selectPod = (nextPod: string) => {
    stopStream(streamRef);
    setPaused(false);
    setStatus(t("Idle."));
    setPod(nextPod);
  };

  const selectContainer = (nextContainer: string) => {
    stopStream(streamRef);
    setPaused(false);
    setStatus(t("Idle."));
    setContainer(nextContainer);
  };

  return (
    <div className="logs-console">
      <div className="logs-source-bar">
        <label><span>{t("Pod")}</span><select className="hyper-input" value={pod} onChange={(event) => selectPod(event.target.value)}>{pods.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label><span>{t("Container")}</span><select className="hyper-input" value={container} onChange={(event) => selectContainer(event.target.value)}>{(pods.find((item) => item.name === pod)?.containers || []).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <div className="logs-stream-actions">
          <AppButton onClick={start}><Activity size={15} />{t("Stream")}</AppButton>
          <AppButton variant="ghost" disabled={!paused && status !== t("Streaming...")} onClick={togglePause}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? t("Resume") : t("Pause")}</AppButton>
        </div>
      </div>
      <div className="logs-utility-bar">
        <span className="logs-status"><i className={status === t("Streaming...") ? "live" : ""} />{status}</span>
        <label className="logs-search"><Search size={14} /><span className="sr-only">{t("Filter logs")}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Filter logs")} /></label>
        <span className="logs-line-count">{visibleLines.length} / {lines.length} {t("lines")}</span>
        <button type="button" aria-label={t("Toggle line wrapping")} className={wrap ? "active" : ""} onClick={() => setWrap((current) => !current)}><WrapText size={15} /></button>
        <button type="button" aria-label={t("Copy visible logs")} disabled={!visibleLines.length} onClick={() => void copyLogs()}><Copy size={15} /></button>
        <button type="button" aria-label={t("Clear logs")} disabled={!lines.length} onClick={() => setLines([])}><Trash2 size={15} /></button>
      </div>
      <div ref={viewerRef} className={`log-viewer ${wrap ? "wrap" : "nowrap"}`} aria-live="polite">
        {visibleLines.length ? visibleLines.map((line) => <div className={`log-line ${line.kind}`} key={`${line.lineNumber}:${line.text}`}><span>{line.lineNumber}</span><code>{line.text}</code></div>) : <div className="logs-empty"><SquareTerminal size={24} /><strong>{query ? t("No matching log lines") : t("Start the stream to inspect container output")}</strong><span>{query ? t("Try a different filter.") : t("The latest 200 lines will appear here in real time.")}</span></div>}
      </div>
    </div>
  );
}

function stopStream(ref: MutableRefObject<EventSource | null>) {
  if (!ref.current) return;
  ref.current.close();
  ref.current = null;
}

function NetworkingInfo({ service }: { service: NetworkingService }) {
  return <><Kv rows={[[t("Service"), <Tag>{service.name}</Tag>], [t("Type"), <Tag>{service.type}</Tag>], [t("Cluster IP"), service.clusterIP ? <Tag>{service.clusterIP}</Tag> : null], [t("External IPs"), service.externalIPs?.length ? service.externalIPs.map((ip) => <Tag key={ip}>{ip}</Tag>) : null]]} /><h4 className="detail-subtitle">{t("Ports")}</h4><ul className="detail-list">{service.ports.map((port) => <li key={`${port.protocol}:${port.port}:${port.name || ""}`}><Tag>{port.protocol} {port.port}</Tag>{port.targetPort !== null && port.targetPort !== undefined ? <><span>{t("to target")}</span><Tag>{String(port.targetPort)}</Tag></> : null}{port.nodePort ? <><span>{t("NodePort")}</span><Tag>{port.nodePort}</Tag></> : null}{port.name ? <span>({port.name})</span> : null}</li>)}</ul></>;
}

const TRANSIENT_WAITING = new Set(["ContainerCreating", "PodInitializing"]);

function podStatusPill(pod: PodSummary): { tone: "ok" | "warn" | "bad"; label: string; detail?: string } {
  const badWaiting = pod.containers.find((c) => c.waitingReason && !TRANSIENT_WAITING.has(c.waitingReason));
  if (badWaiting?.waitingReason) return { tone: "bad", label: badWaiting.waitingReason, detail: `${pod.phase} · container ${badWaiting.name}` };
  const badTerminated = pod.containers.find((c) => c.terminatedReason && c.terminatedReason !== "Completed");
  if (badTerminated?.terminatedReason) return { tone: "bad", label: badTerminated.terminatedReason, detail: `${pod.phase} · container ${badTerminated.name}` };
  const ok = pod.phase === "Running" && pod.containers.every((c) => c.ready);
  return { tone: ok ? "ok" : "warn", label: pod.phase };
}

function PodsTable({ name, pods, openModal }: { name: string; pods: PodSummary[]; openModal: (modal: ModalState) => void }) {
  return <div className="pod-list">{pods.map((pod) => { const restarts = pod.containers.reduce((sum, item) => sum + (item.restartCount || 0), 0); const status = podStatusPill(pod); const container = pod.containers[0]?.name; return (
    <article className={`pod-row ${status.tone}`} key={pod.name}>
      <span className="pod-status-dot" aria-hidden="true" />
      <div className="pod-identity"><strong>{pod.name}</strong><span>{pod.containers.map((item) => item.name).join(", ")}</span></div>
      <div className="pod-fact"><span>{t("Status")}</span><Pill tone={status.tone} title={status.detail}>{status.label}</Pill></div>
      <div className="pod-fact"><span>{t("Pod IP")}</span><code>{pod.podIP || "—"}</code></div>
      <div className="pod-fact"><span>{t("Node")}</span><strong>{pod.nodeName || "—"}</strong></div>
      <div className={`pod-fact pod-restarts ${restarts ? "bad" : ""}`}><span>{t("Restarts")}</span><strong>{restarts}</strong></div>
      {container ? <button className="icon-button" type="button" aria-label={`Open terminal for ${pod.name}`} onClick={() => openModal({ type: "terminal", name, pod: pod.name, container })}><SquareTerminal size={16} /></button> : null}
    </article>
  ); })}</div>;
}

function EventsTable({ items }: { items: K8sEvent[] }) {
  return <ol className="event-list">{items.map((event, index) => {
    const warning = event.type === "Warning";
    return <li className={warning ? "warning" : "normal"} key={`${event.involvedObject.name}:${event.lastTimestamp ?? ""}:${index}`}>
      <span className="event-marker">{warning ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}</span>
      <div className="event-content">
        <div className="event-heading"><strong>{event.reason}</strong><Pill tone={warning ? "bad" : "ok"}>{event.type}</Pill>{event.count > 1 ? <Tag>×{event.count}</Tag> : null}<time>{fmtTs(event.lastTimestamp ?? undefined)}</time></div>
        <p>{event.message}</p>
        <span className="event-object">{event.involvedObject.kind} · <code>{event.involvedObject.name}</code></span>
      </div>
    </li>;
  })}</ol>;
}

function gateLabel(raw?: string | null): string {
  if (!raw) return "";
  try {
    const g = JSON.parse(raw) as { ok: boolean; lastReason?: string };
    return g.ok ? t("gate ✓") : `gate ✗ ${g.lastReason ?? ""}`;
  } catch {
    return "";
  }
}

function DeploymentTable({ items }: { items: Deployment[] }) {
  return <div className="table-wrap"><table><thead><tr><th>{t("Tag")}</th><th>{t("Status")}</th><th>{t("Started")}</th><th>{t("Message")}</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><Tag>{item.tag}</Tag>{item.action === "rollback" ? <Pill tone="warn">{t("rollback")}</Pill> : null}</td><td><Pill tone={item.status}>{item.status}</Pill></td><td>{fmtTs(item.started_at)}</td><td>{[item.message, gateLabel(item.health_gate_result)].filter(Boolean).join(" · ")}</td></tr>)}</tbody></table></div>;
}

function DetailSection({ title, icon, meta, children }: { title: string; icon?: ReactNode; meta?: string; children: ReactNode }) {
  return <section className="detail-section"><header><div>{icon ? <span>{icon}</span> : null}<h3>{title}</h3></div>{meta ? <small>{meta}</small> : null}</header><div className="detail-section-body">{children}</div></section>;
}

function Kv({ rows }: { rows: [string, ReactNode | null][] }) {
  return <dl className="kv-list">{rows.map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{value ?? <span className="text-[var(--mut)]">-</span>}</dd></Fragment>)}</dl>;
}
