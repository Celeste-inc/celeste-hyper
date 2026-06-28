import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    onData = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

import { Terminal } from "./Terminal";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
});

describe("Terminal modal", () => {
  it("mints a token and opens a WebSocket to the exec endpoint", async () => {
    const spy = vi.spyOn(http, "execToken").mockResolvedValue({ status: 200, body: { token: "tok-123", expiresAt: "2026-01-01T00:00:00Z" } } as never);
    render(<Terminal name="web" pod="web-abc" container="app" {...actions()} />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("web", "web-abc", "app"));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(MockWebSocket.instances[0]?.url).toContain("/api/services/web/exec?token=tok-123");
  });

  it("does not open a WebSocket and notifies on a forbidden token mint", async () => {
    vi.spyOn(http, "execToken").mockResolvedValue({ status: 403, body: { error: "forbidden" } } as never);
    const a = actions();
    render(<Terminal name="web" pod="web-abc" container="app" {...a} />);
    await waitFor(() => expect(a.notify).toHaveBeenCalled());
    expect(a.notify.mock.calls[0]?.[1]).toBe("bad");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("renders the pod and container in the title", () => {
    vi.spyOn(http, "execToken").mockResolvedValue({ status: 200, body: { token: "t", expiresAt: "" } } as never);
    render(<Terminal name="web" pod="web-abc" container="app" {...actions()} />);
    expect(screen.getByRole("heading").textContent).toContain("web-abc");
  });
});
