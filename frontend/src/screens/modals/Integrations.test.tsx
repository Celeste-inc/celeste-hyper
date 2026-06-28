import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Integrations } from "./Integrations";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

const token = { id: 1, name: "github-actions", role: "operator", serviceScope: null, clusterScope: null, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, expiresAt: null, revokedAt: null };
const webhook = { id: 5, name: "dockerhub-prod", kind: "dockerhub", secretId: "abc123", url: "/api/webhooks/registry/abc123", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, revokedAt: null };

describe("Integrations modal", () => {
  it("renders existing machine tokens and registry webhooks", async () => {
    vi.spyOn(http, "machineTokens").mockResolvedValue({ status: 200, body: { items: [token] } } as never);
    vi.spyOn(http, "webhooks").mockResolvedValue({ status: 200, body: { items: [webhook] } } as never);
    render(<Integrations {...actions()} />);
    await waitFor(() => expect(screen.getByText("github-actions")).toBeTruthy());
    expect(screen.getByText("/api/webhooks/registry/abc123")).toBeTruthy();
  });

  it("creates a token and reveals the cleartext value once", async () => {
    vi.spyOn(http, "machineTokens").mockResolvedValue({ status: 200, body: { items: [] } } as never);
    vi.spyOn(http, "webhooks").mockResolvedValue({ status: 200, body: { items: [] } } as never);
    const create = vi.spyOn(http, "createMachineToken").mockResolvedValue({ status: 201, body: { token: "ch_cleartext_value", machineToken: token } } as never);
    render(<Integrations {...actions()} />);
    await waitFor(() => screen.getByLabelText("Token name"));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "github-actions" } });
    fireEvent.click(screen.getByRole("button", { name: /create token/i }));
    await waitFor(() => expect(screen.getByText("ch_cleartext_value")).toBeTruthy());
    expect(create).toHaveBeenCalledWith({ name: "github-actions", role: "operator" });
  });

  it("revokes a token after confirmation", async () => {
    vi.spyOn(http, "machineTokens").mockResolvedValue({ status: 200, body: { items: [token] } } as never);
    vi.spyOn(http, "webhooks").mockResolvedValue({ status: 200, body: { items: [] } } as never);
    const revoke = vi.spyOn(http, "revokeMachineToken").mockResolvedValue({ status: 200, body: { revoked: true } } as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Integrations {...actions()} />);
    await waitFor(() => screen.getByText("github-actions"));
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(1));
  });
});
