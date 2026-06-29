import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import type { ServiceActions } from "../components/organisms/Cards";
import type { WorkloadSummary } from "../shared/types/api";

const actions: ServiceActions = {
  onDeploy: () => {},
  onEnv: () => {},
  onHistory: () => {},
  onSettings: () => {},
  onDetail: () => {},
};

function renderDashboard(over: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  return render(
    <Dashboard
      clusters={[]}
      services={[]}
      unmanaged={[]}
      clusterLabel={(id) => id}
      actions={actions}
      onAddCluster={() => {}}
      onEditCluster={() => {}}
      onCheckCluster={() => {}}
      onBrowseCrds={() => {}}
      onAddService={() => {}}
      onBrowseTemplates={() => {}}
      onManageRegistries={() => {}}
      onAdopt={() => {}}
      infrastructure={[]}
      onReclassify={() => {}}
      {...over}
    />,
  );
}

const infraWorkload: WorkloadSummary = {
  clusterId: "primary",
  kind: "Deployment",
  name: "coredns",
  namespace: "kube-system",
} as WorkloadSummary;

describe("Dashboard", () => {
  it("renders the control plane heading", () => {
    const { getByRole } = renderDashboard();
    expect(getByRole("heading", { name: "Control plane" })).toBeTruthy();
  });

  it("reflects cluster health in the summary detail", () => {
    const { getByText } = renderDashboard({
      clusters: [
        { id: "primary", name: "Primary", kubeconfigPath: "/k", defaultNamespace: "default", runtime: "auto", enabled: true } as any,
      ],
    });
    // 1 cluster, none reporting health.ok → the Clusters tile detail reads "0 reachable".
    // Fails if the healthy-cluster computation or prop wiring breaks.
    expect(getByText("0 reachable")).toBeTruthy();
  });

  it("hides the cluster-infrastructure list by default and reveals it on toggle", () => {
    renderDashboard({ infrastructure: [infraWorkload] });
    fireEvent.click(screen.getByRole("button", { name: /Discoveries/i }));
    // collapsed: the toggle shows a count but the workload name is not rendered yet
    expect(screen.getByText("Cluster infrastructure")).toBeTruthy();
    expect(screen.getByText("1 item")).toBeTruthy();
    expect(screen.queryByText("coredns")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Cluster infrastructure/i }));
    expect(screen.getByText("coredns")).toBeTruthy();
    expect(screen.getByText("kube-system")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Move to applications/i })).toBeTruthy();
  });
});
