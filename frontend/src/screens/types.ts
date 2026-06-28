import type { EnvKind, HpaView, WorkloadSummary } from "../shared/types/api";

export type Notify = (message: string, kind?: "bad") => void;

export type ModalState =
  | { type: "cluster-create"; prefill?: { name?: string; notes?: string } }
  | { type: "cluster-edit"; id: string }
  | { type: "service-create" }
  | { type: "adopt"; workload: WorkloadSummary }
  | { type: "service-settings"; name: string }
  | { type: "deploy"; name: string }
  | { type: "rollback"; name: string }
  | { type: "deploy-progress"; name: string; tag: string; deploymentId: number }
  | { type: "env"; name: string; kind: EnvKind }
  | { type: "ingress-yaml"; clusterId: string; namespace: string; name: string }
  | { type: "crds"; clusterId: string }
  | { type: "hpa"; name: string; hpa: HpaView }
  | { type: "history"; name: string }
  | { type: "terminal"; name: string; pod: string; container: string }
  | { type: "integrations" }
  | { type: "setup" }
  | { type: "discovery" }
  | { type: "audit" };

export interface ModalActions {
  setModal: (modal: ModalState | null) => void;
  closeModal: () => void;
  notify: Notify;
  load: () => Promise<void>;
}
