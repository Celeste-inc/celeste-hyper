import { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, Moon, Plug, Radar, RefreshCw, ScrollText, Server, Settings2, Sun } from "lucide-react";
import type { Cluster, EnvKind, ServiceListItem, WorkloadSummary } from "../shared/types/api";
import { http, setCsrfToken } from "../shared/api/client";
import { apiError, fmtTs } from "../shared/utils/format";
import { t } from "../shared/i18n/t";
import { Modal } from "../components/molecules/Modal";
import { Toast, type ToastState } from "../components/molecules/Toast";
import { Dashboard } from "../screens/Dashboard";
import { ServiceDetail } from "../screens/ServiceDetail";
import { Login } from "../screens/Login";
import { ChangePassword } from "../screens/ChangePassword";
import { Adopt } from "../screens/modals/Adopt";
import { AuditTimeline } from "../screens/modals/AuditTimeline";
import { ClusterForm } from "../screens/modals/ClusterForm";
import { CrdBrowser } from "../screens/modals/CrdBrowser";
import { Deploy } from "../screens/modals/Deploy";
import { Discovery } from "../screens/modals/Discovery";
import { Rollback } from "../screens/modals/Rollback";
import { DeployProgress } from "../screens/modals/DeployProgress";
import { Env } from "../screens/modals/Env";
import { IngressYaml } from "../screens/modals/IngressYaml";
import { HpaEdit } from "../screens/modals/HpaEdit";
import { History } from "../screens/modals/History";
import { Integrations } from "../screens/modals/Integrations";
import { FleetEnrollment } from "../screens/modals/FleetEnrollment";
import { ServiceForm } from "../screens/modals/ServiceForm";
import { Settings } from "../screens/modals/Settings";
import { DeleteService } from "../screens/modals/DeleteService";
import { Templates } from "../screens/modals/Templates";
import { TemplateDeploy } from "../screens/modals/TemplateDeploy";
import { Registries } from "../screens/modals/Registries";
import { Scaling } from "../screens/modals/Scaling";
import { NetworkingEdit } from "../screens/modals/NetworkingEdit";
import { DeletePod } from "../screens/modals/DeletePod";
import { Setup } from "../screens/modals/Setup";
import { Terminal } from "../screens/modals/Terminal";
import type { ModalActions, ModalState } from "../screens/types";

type Theme = "light" | "dark";

export function App() {
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem("hyper-theme") === "dark" ? "dark" : "light");
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [services, setServices] = useState<ServiceListItem[]>([]);
  const [unmanaged, setUnmanaged] = useState<WorkloadSummary[]>([]);
  const [infrastructure, setInfrastructure] = useState<WorkloadSummary[]>([]);
  const [lastTickAt, setLastTickAt] = useState<string>();
  const [headerInfo, setHeaderInfo] = useState(t("Cluster control plane"));
  const [modal, setModal] = useState<ModalState | null>(null);
  const [detailName, setDetailName] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [mustChange, setMustChange] = useState(false);
  const [role, setRole] = useState<string | null>(null);

  const notify = useCallback((message: string, kind?: "bad") => setToast({ message, kind }), []);
  const closeModal = useCallback(() => setModal(null), []);
  const clusterLabel = useCallback((id: string) => clusters.find((cluster) => cluster.id === id)?.name ?? id, [clusters]);

  // If the open detail sheet's service is gone (e.g. purged), close the sheet and any modal that
  // referenced it so the operator doesn't stare at a dead row. The DeleteService modal stays open
  // so the operator can read the "Service purged" success view before closing it themselves.
  useEffect(() => {
    if (!detailName) return;
    const gone = !services.some((s) => s.name === detailName);
    if (!gone) return;
    setDetailName(null);
    setModal((m) => {
      if (!m) return null;
      if (m.type === "service-delete") return m; // keep the success modal up
      if ((m as { name?: string }).name === detailName) return null;
      return m;
    });
  }, [services, detailName]);

  const load = useCallback(async () => {
    try {
      const [clusterRes, serviceRes, systemRes] = await Promise.all([http.clusters(), http.services(), http.system()]);
      setClusters(clusterRes.body.items || []);
      setServices(serviceRes.body.items || []);
      setUnmanaged(serviceRes.body.unmanaged || []);
      setInfrastructure(serviceRes.body.infrastructure || []);
      setLastTickAt(serviceRes.body.lastTickAt);
      setHeaderInfo(`${systemRes.body.clusters || 0} cluster${systemRes.body.clusters === 1 ? "" : "s"} · bucket ${systemRes.body.r2?.bucket || "-"}`);
    } catch {
      setHeaderInfo(t("Control plane unavailable"));
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("hyper-theme", theme);
  }, [theme]);

  const checkMe = useCallback(async () => {
    const res = await http.me();
    if (res.status === 200) {
      setAuthed(true);
      setMustChange(res.body.mustChangePassword === true);
      setRole(res.body.role);
      setCsrfToken(res.body.csrfToken);
    } else {
      setAuthed(false);
      setRole(null);
      setCsrfToken(null);
    }
  }, []);

  useEffect(() => {
    void checkMe().catch(() => setAuthed(false));
  }, [checkMe]);

  useEffect(() => {
    if (!authed) return;
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [load, authed]);

  const actions = useMemo(() => ({
    onDeploy: (name: string) => setModal({ type: "deploy", name }),
    onEnv: (name: string, kind: EnvKind) => setModal({ type: "env", name, kind }),
    onHistory: (name: string) => setModal({ type: "history", name }),
    onSettings: (name: string) => setModal({ type: "service-settings", name }),
    onDetail: (name: string) => setDetailName(name),
  }), []);

  const onCheckCluster = async (id: string) => {
    notify(`Checking ${id}...`);
    const result = await http.checkCluster(id);
    if (result.status >= 400) {
      notify(apiError(result.body, result.status), "bad");
      return;
    }
    notify(result.body.health.ok ? t("Cluster reachable") : `Cluster ${result.body.health.reachable ? "degraded" : "unreachable"}`, result.body.health.ok ? undefined : "bad");
    await load();
  };

  const onReclassify = async (workload: WorkloadSummary, category: "application" | "infrastructure") => {
    const res = await http.setWorkloadOverride(workload.clusterId, { namespace: workload.namespace, kind: workload.kind, name: workload.name, category });
    if (res.status >= 400) {
      notify(apiError(res.body, res.status), "bad");
      return;
    }
    notify(`Marked ${workload.name} as ${category}`);
    await load();
  };

  const modalActions: ModalActions = { setModal, closeModal, notify, load };

  if (authed === null) return <main className="app-main" aria-busy="true" />;
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  if (!authed) return <Login onAuthed={() => void checkMe()} theme={theme} onToggleTheme={toggleTheme} />;
  if (mustChange) return <ChangePassword onChanged={() => void checkMe()} theme={theme} onToggleTheme={toggleTheme} />;

  return (
    <>
      <header className="app-header">
        <nav className="app-nav">
          <div className="brand-row">
            <div className="flex min-w-0 items-center gap-2">
              <span className="brand-mark" aria-hidden="true"><Cloud size={16} /></span>
              <h1 className="m-0 whitespace-nowrap text-[15px] font-semibold tracking-[-0.015em]">Celeste Hyper</h1>
            </div>
          </div>
          <div className="header-context"><span className="header-divider" /><span>{headerInfo}</span></div>
          <div className="status-row">
            <span className="scan-status"><RefreshCw size={13} />{lastTickAt ? `Updated ${fmtTs(lastTickAt)}` : t("Waiting for first scan")}</span>
            <button className="theme-toggle" type="button" aria-label={t("Audit")} onClick={() => setModal({ type: "audit" })}><ScrollText size={16} /></button>
            {role === "admin" ? <button className="theme-toggle" type="button" aria-label={t("Setup")} onClick={() => setModal({ type: "setup" })}><Settings2 size={16} /></button> : null}
            {role === "admin" ? <button className="theme-toggle" type="button" aria-label={t("Add machine")} onClick={() => setModal({ type: "enrollment" })}><Server size={16} /></button> : null}
            {role === "admin" ? <button className="theme-toggle" type="button" aria-label={t("Integrations")} onClick={() => setModal({ type: "integrations" })}><Plug size={16} /></button> : null}
            {role === "admin" ? <button className="theme-toggle" type="button" aria-label={t("Discovery")} onClick={() => setModal({ type: "discovery" })}><Radar size={16} /></button> : null}
            <button className="theme-toggle" type="button" aria-label={theme === "dark" ? t("Switch to light mode") : t("Switch to dark mode")} onClick={toggleTheme}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
          </div>
        </nav>
      </header>
      <Dashboard
        clusters={clusters}
        services={services}
        unmanaged={unmanaged}
        infrastructure={infrastructure}
        clusterLabel={clusterLabel}
        actions={actions}
        onAddCluster={() => setModal({ type: "cluster-create" })}
        onEditCluster={(id) => setModal({ type: "cluster-edit", id })}
        onCheckCluster={(id) => void onCheckCluster(id)}
        onBrowseCrds={(id) => setModal({ type: "crds", clusterId: id })}
        onAddService={() => setModal({ type: "service-create" })}
        onBrowseTemplates={() => setModal({ type: "templates" })}
        onManageRegistries={() => setModal({ type: "registries" })}
        onAdopt={(workload) => setModal({ type: "adopt", workload })}
        onReclassify={(workload, category) => void onReclassify(workload, category)}
      />
      {detailName ? <ServiceDetail name={detailName} services={services} clusterLabel={clusterLabel} notify={notify} onClose={() => setDetailName(null)} setModal={setModal} isObscured={modal !== null} /> : null}
      {modal ? <Modal onClose={closeModal}>{renderModal(modal, modalActions, clusters)}</Modal> : null}
      <Toast toast={toast} onDone={() => setToast(null)} />
    </>
  );
}

function renderModal(modal: ModalState, actions: ModalActions, clusters: Cluster[]) {
  if (modal.type === "cluster-create") return <ClusterForm mode="create" prefill={modal.prefill} {...actions} />;
  if (modal.type === "cluster-edit") return <ClusterForm mode="edit" cluster={clusters.find((cluster) => cluster.id === modal.id)} {...actions} />;
  if (modal.type === "service-create") return <ServiceForm clusters={clusters} {...actions} />;
  if (modal.type === "adopt") return <Adopt workload={modal.workload} clusters={clusters} {...actions} />;
  if (modal.type === "service-settings") return <Settings name={modal.name} {...actions} />;
  if (modal.type === "service-delete") return <DeleteService name={modal.name} {...actions} />;
  if (modal.type === "templates") return <Templates {...actions} />;
  if (modal.type === "template-deploy") return <TemplateDeploy templateId={modal.templateId} image={modal.image} clusters={clusters} {...actions} />;
  if (modal.type === "registries") return <Registries {...actions} />;
  if (modal.type === "scaling") return <Scaling name={modal.name} {...actions} />;
  if (modal.type === "networking-edit") return <NetworkingEdit name={modal.name} {...actions} />;
  if (modal.type === "deploy") return <Deploy name={modal.name} {...actions} />;
  if (modal.type === "rollback") return <Rollback name={modal.name} {...actions} />;
  if (modal.type === "deploy-progress") return <DeployProgress name={modal.name} tag={modal.tag} deploymentId={modal.deploymentId} {...actions} />;
  if (modal.type === "env") return <Env name={modal.name} kind={modal.kind} {...actions} />;
  if (modal.type === "ingress-yaml") return <IngressYaml clusterId={modal.clusterId} namespace={modal.namespace} name={modal.name} {...actions} />;
  if (modal.type === "crds") return <CrdBrowser clusterId={modal.clusterId} {...actions} />;
  if (modal.type === "hpa") return <HpaEdit name={modal.name} hpa={modal.hpa} {...actions} />;
  if (modal.type === "integrations") return <Integrations {...actions} />;
  if (modal.type === "enrollment") return <FleetEnrollment {...actions} />;
  if (modal.type === "setup") return <Setup {...actions} />;
  if (modal.type === "discovery") return <Discovery {...actions} />;
  if (modal.type === "audit") return <AuditTimeline {...actions} />;
  if (modal.type === "terminal") return <Terminal name={modal.name} pod={modal.pod} container={modal.container} {...actions} />;
  if (modal.type === "pod-delete") return <DeletePod name={modal.name} pod={modal.pod} {...actions} />;
  return <History name={modal.name} />;
}
