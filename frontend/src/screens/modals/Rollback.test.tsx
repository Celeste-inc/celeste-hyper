import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Rollback } from "./Rollback";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

describe("Rollback modal", () => {
  it("shows the previous tag and source when eligible", async () => {
    vi.spyOn(http, "rollbackPreview").mockResolvedValue({
      status: 200,
      body: { eligible: true, previousTag: "v1", previousRevision: null, source: "hyper" },
    } as never);
    render(<Rollback name="hello" {...actions()} />);
    await waitFor(() => expect(screen.getByText("v1")).toBeTruthy());
    expect(screen.getByText(/source: hyper/i)).toBeTruthy();
  });

  it("confirms the rollback and navigates to history", async () => {
    vi.spyOn(http, "rollbackPreview").mockResolvedValue({
      status: 200,
      body: { eligible: true, previousTag: "v1", previousRevision: null, source: "hyper" },
    } as never);
    const rollback = vi.spyOn(http, "rollback").mockResolvedValue({ status: 202, body: { jobId: 7, accepted: true } } as never);
    const a = actions();
    render(<Rollback name="hello" {...a} />);
    await waitFor(() => screen.getByRole("button", { name: /roll back/i }));
    fireEvent.click(screen.getByRole("button", { name: /^roll back$/i }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("hello"));
    expect(a.setModal).toHaveBeenCalledWith({ type: "history", name: "hello" });
  });

  it("explains that r2-bundle services roll back via deploy history", async () => {
    vi.spyOn(http, "rollbackPreview").mockResolvedValue({
      status: 200,
      body: { eligible: false, reason: "r2-bundle-uses-deploy-history", previousTag: null, previousRevision: null, source: null },
    } as never);
    render(<Rollback name="pay" {...actions()} />);
    await waitFor(() => expect(screen.getByText(/redeploying a previous tag from History/i)).toBeTruthy());
  });
});
