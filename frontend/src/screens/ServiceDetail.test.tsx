import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http } from "../shared/api/client";
import { ServiceDetail } from "./ServiceDetail";

const service = {
  name: "sollo-schedulers",
  namespace: "sollo-prod",
  clusterId: "local",
  sourceType: "r2-bundle" as const,
  enabled: true,
  r2Prefix: "sollo-schedulers/",
  manifestRoot: "k8s",
  imageTarPattern: "{name}-{tag}-amd64.tar",
  imageRefPrefix: "docker.io/library",
};

const card = {
  ...service,
  currentTag: "47c9449bb68f",
  deployedAt: "2026-06-28T22:41:00.000Z",
  newVersion: null,
  env: {
    config: { exists: true, keys: ["PORT"], path: "/tmp/config.env" },
    secret: { exists: true, keys: ["TOKEN"], path: "/tmp/secret.env" },
  },
  cluster: {
    kind: "Deployment" as const,
    replicas: 1,
    readyReplicas: 0,
    containers: [{ name: "sollo-schedulers", image: "docker.io/library/sollo-schedulers:47c9449bb68f" }],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ServiceDetail", () => {
  it("prioritizes runtime health and keeps operational details grouped by view", async () => {
    vi.spyOn(http, "service").mockResolvedValue({ status: 200, body: { service } } as never);
    vi.spyOn(http, "deployments").mockResolvedValue({ status: 200, body: { items: [] } } as never);
    vi.spyOn(http, "pods").mockResolvedValue({
      status: 200,
      body: {
        selector: "app=sollo-schedulers",
        items: [{
          name: "sollo-schedulers-5674d9f89b-6xr6t",
          phase: "Running",
          podIP: "10.42.1.18",
          nodeName: "celeste-ai2",
          containers: [{ name: "sollo-schedulers", image: card.cluster.containers[0]!.image, ready: false, restartCount: 3, waitingReason: "CrashLoopBackOff" }],
        }],
      },
    } as never);
    vi.spyOn(http, "events").mockResolvedValue({
      status: 200,
      body: {
        items: [{
          type: "Warning",
          reason: "BackOff",
          message: "Back-off restarting failed container sollo-schedulers",
          involvedObject: { kind: "Pod", name: "sollo-schedulers-5674d9f89b-6xr6t" },
          firstTimestamp: "2026-06-28T22:42:00.000Z",
          lastTimestamp: "2026-06-28T22:43:00.000Z",
          count: 4,
        }],
      },
    } as never);
    vi.spyOn(http, "networking").mockResolvedValue({
      status: 200,
      body: {
        service: {
          name: "sollo-schedulers",
          type: "ClusterIP",
          clusterIP: "10.43.63.5",
          externalIPs: [],
          ports: [{ name: "http", protocol: "TCP", port: 3001, targetPort: "http" }],
          endpoints: [{ kind: "cluster-ip", url: "http://10.43.63.5:3001", description: "In-cluster via ClusterIP (http)", copyable: true }],
        },
      },
    } as never);
    vi.spyOn(http, "rollbackPreview").mockResolvedValue({ status: 200, body: { eligible: false } } as never);
    vi.spyOn(http, "autoRollbackStatus").mockResolvedValue({ status: 200, body: { pending: null, degraded: null } } as never);
    vi.spyOn(http, "hpa").mockResolvedValue({ status: 200, body: { hpa: null } } as never);
    vi.spyOn(http, "helm").mockResolvedValue({ status: 200, body: { helm: null } } as never);

    render(
      <ServiceDetail
        name={service.name}
        services={[card]}
        clusterLabel={() => "Local cluster"}
        notify={vi.fn()}
        onClose={vi.fn()}
        setModal={vi.fn()}
        isObscured={false}
      />,
    );

    await screen.findByRole("heading", { name: service.name });
    const summary = screen.getByLabelText("Service health summary");
    expect(within(summary).getByText("1 unhealthy")).toBeTruthy();
    expect(within(summary).getByText("3")).toBeTruthy();
    expect(within(summary).getByText("1", { selector: "strong" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));

    await waitFor(() => expect(screen.getByText("CrashLoopBackOff")).toBeTruthy());
    expect(screen.getByText("Runtime needs attention")).toBeTruthy();
    expect(screen.getByText("Back-off restarting failed container sollo-schedulers")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Live logs" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByRole("button", { name: "Edit config.env" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit secret.env" })).toBeTruthy();
  });
});
