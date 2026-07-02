import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FleetEnrollment } from "./FleetEnrollment";
import { http } from "../../shared/api/client";
import type { EnrollmentToken } from "../../shared/types/api";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

const token = (over: Partial<EnrollmentToken> = {}): EnrollmentToken => ({
  id: 1,
  name: "lab-edge",
  clusterId: "edge-01",
  clusterName: "Edge 01",
  defaultNamespace: "default",
  runtime: "k3s",
  imageLoad: "remote-pull",
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: "2026-01-01T00:30:00Z",
  usedAt: null,
  usedBy: null,
  revokedAt: null,
  status: "active",
  ...over,
});

describe("FleetEnrollment modal", () => {
  it("lists existing enrollment tokens with their status", async () => {
    vi.spyOn(http, "enrollmentTokens").mockResolvedValue({ status: 200, body: { items: [token()] } } as never);
    render(<FleetEnrollment {...actions()} />);
    await waitFor(() => expect(screen.getByText("lab-edge")).toBeTruthy());
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("mints a token and reveals the join command once", async () => {
    vi.spyOn(http, "enrollmentTokens").mockResolvedValue({ status: 200, body: { items: [] } } as never);
    const create = vi.spyOn(http, "createEnrollmentToken").mockResolvedValue({
      status: 201,
      body: { token: "che_cleartext", joinCommand: "curl ... | sudo MASTER_URL=http://m ENROLL_TOKEN=che_cleartext bash", enrollmentToken: token() },
    } as never);

    render(<FleetEnrollment {...actions()} />);
    await waitFor(() => screen.getByLabelText("Token name"));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "lab-edge" } });
    fireEvent.change(screen.getByLabelText("Cluster id"), { target: { value: "edge-01" } });
    fireEvent.click(screen.getByRole("button", { name: /create token/i }));

    await waitFor(() => expect(screen.getByText(/ENROLL_TOKEN=che_cleartext/)).toBeTruthy());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "lab-edge", clusterId: "edge-01", runtime: "k3s", imageLoad: "remote-pull" }));
  });

  it("blocks minting without a cluster id", async () => {
    vi.spyOn(http, "enrollmentTokens").mockResolvedValue({ status: 200, body: { items: [] } } as never);
    const create = vi.spyOn(http, "createEnrollmentToken");
    const a = actions();
    render(<FleetEnrollment {...a} />);
    await waitFor(() => screen.getByLabelText("Token name"));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "lab-edge" } });
    fireEvent.click(screen.getByRole("button", { name: /create token/i }));
    expect(create).not.toHaveBeenCalled();
    expect(a.notify).toHaveBeenCalled();
  });
});
