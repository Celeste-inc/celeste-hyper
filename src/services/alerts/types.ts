export type AlertSeverity = "critical" | "error" | "warning";

export type AlertCategory =
  | "app-error"
  | "pod-crashloop"
  | "pod-oom"
  | "pod-image"
  | "pod-not-ready"
  | "pod-restart"
  | "k8s-event"
  | "deploy-failed"
  | "service-degraded"
  | "env-drift"
  | "hyper-error"
  | "watcher-error";

export interface Alert {
  key: string;
  severity: AlertSeverity;
  category: AlertCategory;
  service: string;
  title: string;
  detail: string;
  namespace?: string;
  pod?: string;
  container?: string;
  cluster?: string;
  condition?: boolean;
  tags?: string[];
  errorCode?: string;
  probableCause?: string;
  suggestedAction?: string;
  occurredAt: string;
}

export interface AlertRecord {
  key: string;
  severity: AlertSeverity;
  category: AlertCategory;
  service: string;
  title: string;
  scope: string;
  firstSeen: string;
  lastSeen: string;
  lastSent: string | null;
  suppressed: number;
  total: number;
  open: boolean;
  condition: boolean;
}

export interface AlertStore {
  getAlert(key: string): AlertRecord | null;
  saveAlert(record: AlertRecord): void;
  openConditions(): AlertRecord[];
  getCursor(key: string): string | null;
  setCursor(key: string, value: string): void;
  pruneAlerts(olderThanIso: string): number;
}
