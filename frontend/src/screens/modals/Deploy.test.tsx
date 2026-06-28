import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Deploy } from "./Deploy";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

function mockService(deployMode: string) {
  vi.spyOn(http, "service").mockResolvedValue({
    status: 200,
    body: { service: { sourceType: "registry-pull", name: "web", namespace: "default", clusterId: "c1", enabled: true, imageRef: "img", workloadKind: "Deployment", deployMode }, currentTag: null, deployedAt: null },
  } as never);
  vi.spyOn(http, "versions").mockResolvedValue({ status: 200, body: { items: [], total: 0 } } as never);
}

describe("Deploy modal — deploy mode", () => {
  it("shows the deploy-mode pill", async () => {
    mockService("canary");
    render(<Deploy name="web" {...actions()} />);
    await waitFor(() => expect(screen.getByText("canary")).toBeTruthy());
  });

  it("recreate shows a downtime warning", async () => {
    mockService("recreate");
    render(<Deploy name="web" {...actions()} />);
    await waitFor(() => expect(screen.getByText(/Downtime expected/i)).toBeTruthy());
  });

  it("blue-green shows the flip/drain note", async () => {
    mockService("blue-green");
    render(<Deploy name="web" {...actions()} />);
    await waitFor(() => expect(screen.getByText(/flipped to it/i)).toBeTruthy());
  });
});
