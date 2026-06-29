import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteService } from "./DeleteService";
import { http } from "../../shared/api/client";

afterEach(() => {
  vi.restoreAllMocks();
});

const baseProps = {
  notify: vi.fn(),
  closeModal: vi.fn(),
  setModal: vi.fn(),
  load: vi.fn().mockResolvedValue(undefined),
};

const dryRunBody = {
  ok: true as const,
  purge: { removed: [], failed: [], planned: ["Deployment/api", "Service/api", "ConfigMap/api-config", "Secret/api-secret"] },
};

const finalBody = {
  ok: true as const,
  purge: { planned: [], removed: ["Deployment/api", "Service/api", "ConfigMap/api-config", "Secret/api-secret"], failed: [] },
};

describe("DeleteService modal", () => {
  it("renders the purge preview from the dry-run", async () => {
    const spy = vi.spyOn(http, "deleteService").mockResolvedValue({ status: 200, body: dryRunBody } as never);
    render(<DeleteService name="api" {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Deployment/api")).toBeTruthy());
    expect(screen.getByText("Service/api")).toBeTruthy();
    expect(screen.getByText("ConfigMap/api-config")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith("api", { dryRun: true });
  });

  it("disables the Delete button until the operator types the service name exactly", async () => {
    vi.spyOn(http, "deleteService").mockResolvedValue({ status: 200, body: dryRunBody } as never);
    render(<DeleteService name="api" {...baseProps} />);
    const btn = screen.getByRole("button", { name: /delete and purge/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const input = screen.getByLabelText(/type the service name/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ap" } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "api" } });
    expect(btn.disabled).toBe(false);
  });

  it("fires the live delete (no dryRun) when the operator confirms", async () => {
    const spy = vi.spyOn(http, "deleteService")
      .mockResolvedValueOnce({ status: 200, body: dryRunBody } as never) // preview
      .mockResolvedValueOnce({ status: 200, body: finalBody } as never); // actual purge
    render(<DeleteService name="api" {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Deployment/api")).toBeTruthy());
    const input = screen.getByLabelText(/type the service name/i);
    fireEvent.change(input, { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: /delete and purge/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /service purged/i })).toBeTruthy());
    expect(baseProps.load).toHaveBeenCalled();
    // Final delete call passes no dryRun.
    expect(spy.mock.calls[1]).toEqual(["api"]);
  });

  it("surfaces failed resources from the purge manifest", async () => {
    const failedBody = {
      ok: true as const,
      purge: { planned: [], removed: ["Deployment/api"], failed: [{ resource: "HPA/api", reason: "Forbidden" }] },
    };
    vi.spyOn(http, "deleteService")
      .mockResolvedValueOnce({ status: 200, body: dryRunBody } as never)
      .mockResolvedValueOnce({ status: 200, body: failedBody } as never);
    render(<DeleteService name="api" {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Deployment/api")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/type the service name/i), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: /delete and purge/i }));
    await waitFor(() => expect(screen.getByText("1 failed")).toBeTruthy());
  });
});
