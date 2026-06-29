import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http } from "../../shared/api/client";
import { TemplateDeploy } from "./TemplateDeploy";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    const callback = listener as (event: MessageEvent<string>) => void;
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }

  emit(name: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  close() {}
}

const props = {
  templateId: "nginx",
  clusters: [{ id: "local", name: "Local", defaultNamespace: "default", runtime: "auto" as const, enabled: true, serviceCount: 0 }],
  notify: vi.fn(),
  closeModal: vi.fn(),
  setModal: vi.fn(),
  load: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(http, "templates").mockResolvedValue({
    status: 200,
    body: {
      items: [{
        id: "nginx",
        label: "NGINX",
        category: "web",
        image: "nginx",
        defaultTag: "1.27",
        defaultPort: 80,
        portName: "http",
        description: "HTTP server",
        env: [],
      }],
    },
  } as never);
  vi.spyOn(http, "registrySources").mockResolvedValue({ status: 200, body: { items: [] } } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TemplateDeploy result", () => {
  it("shows a structured result and deduplicates raw deployment statuses", async () => {
    vi.spyOn(http, "deployTemplate").mockResolvedValue({
      status: 201,
      body: {
        deploymentId: 42,
        applied: [
          { kind: "Service", name: "web", namespace: "default" },
          { kind: "Deployment", name: "web", namespace: "default" },
        ],
        loadBalancer: { kind: "ClusterIP", replicas: 2, message: "Traffic is balanced across two replicas." },
      },
    } as never);

    render(<TemplateDeploy {...(props as ComponentProps<typeof TemplateDeploy>)} />);
    fireEvent.change(await screen.findByLabelText("Service name"), { target: { value: "web" } });
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0]!;
    expect(stream.url).toBe("/api/deployments/42/stream");

    stream.emit("status", { status: "applying", message: "first apply" });
    stream.emit("status", { status: "applying", message: "resources applied" });
    stream.emit("status", { status: "done", message: "template applied" });

    await screen.findByRole("heading", { name: "Service deployed" });
    expect(screen.getByText("Resources created")).toBeTruthy();
    expect(screen.getByText("Traffic is balanced across two replicas.")).toBeTruthy();
    expect(screen.getByText("resources applied")).toBeTruthy();
    expect(screen.queryByText("first apply")).toBeNull();
    expect(screen.queryByText(/^done$/i)).toBeNull();
  });
});
