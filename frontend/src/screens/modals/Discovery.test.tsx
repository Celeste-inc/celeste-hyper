import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Discovery } from "./Discovery";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

const candidate = { ip: "10.0.0.5", port: 6443, reachable: true, serverVersion: "v1.29.4", distribution: "k3s", authMethods: ["anonymous"], ms: 12 };
const scanResult = { status: 200, body: { candidates: [candidate], tuplesScanned: 3, ipsScanned: 1, timedOut: false } };

const scanButton = () => screen.getByRole("button", { name: /^scan$/i }) as HTMLButtonElement;

describe("Discovery modal", () => {
  it("disables the Scan button until the consent checkbox is checked", () => {
    render(<Discovery {...actions()} />);
    expect(scanButton().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/authorized to scan/i));
    expect(scanButton().disabled).toBe(false);
  });

  it("renders a candidate row after a successful scan", async () => {
    vi.spyOn(http, "scanDiscovery").mockResolvedValue(scanResult as never);
    render(<Discovery {...actions()} />);
    fireEvent.change(screen.getByLabelText("Targets"), { target: { value: "10.0.0.0/24" } });
    fireEvent.click(screen.getByLabelText(/authorized to scan/i));
    fireEvent.click(scanButton());
    await waitFor(() => expect(screen.getByText("10.0.0.5")).toBeTruthy());
    expect(screen.getByText("v1.29.4")).toBeTruthy();
    expect(screen.getByText("k3s")).toBeTruthy();
  });

  it("promotes a candidate to a prefilled cluster-create modal", async () => {
    vi.spyOn(http, "scanDiscovery").mockResolvedValue(scanResult as never);
    const a = actions();
    render(<Discovery {...a} />);
    fireEvent.change(screen.getByLabelText("Targets"), { target: { value: "10.0.0.0/24" } });
    fireEvent.click(screen.getByLabelText(/authorized to scan/i));
    fireEvent.click(scanButton());
    await waitFor(() => screen.getByRole("button", { name: /promote to cluster/i }));
    fireEvent.click(screen.getByRole("button", { name: /promote to cluster/i }));
    expect(a.setModal).toHaveBeenCalledWith({
      type: "cluster-create",
      prefill: { name: "discovered-10.0.0.5", notes: "API server https://10.0.0.5:6443 (k3s v1.29.4)" },
    });
  });
});
