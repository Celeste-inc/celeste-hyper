import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HpaEdit } from "./HpaEdit";
import { http } from "../../shared/api/client";
import type { HpaView } from "../../shared/types/api";

const hpa: HpaView = {
  name: "web",
  minReplicas: 2,
  maxReplicas: 10,
  currentReplicas: 3,
  desiredReplicas: 4,
  targetCPUUtilizationPercentage: 50,
  metricTypes: ["cpu"],
};
const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn().mockResolvedValue(undefined) });

describe("HpaEdit modal", () => {
  it("prefills current values and PATCHes the changed fields", async () => {
    const patch = vi.spyOn(http, "patchHpa").mockResolvedValue({ status: 200, body: { hpa } } as never);
    const a = actions();
    render(<HpaEdit name="web" hpa={hpa} {...a} />);
    expect((screen.getByLabelText("Target CPU %") as HTMLInputElement).value).toBe("50");
    fireEvent.change(screen.getByLabelText("Target CPU %"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("web", { min: 2, max: 10, targetCPUUtilizationPercentage: 80 }));
    expect(a.closeModal).toHaveBeenCalled();
  });

  it("surfaces a server validation error", async () => {
    vi.spyOn(http, "patchHpa").mockResolvedValue({ status: 422, body: { error: "min/max out of range" } } as never);
    const a = actions();
    render(<HpaEdit name="web" hpa={hpa} {...a} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(a.notify).toHaveBeenCalledWith(expect.stringContaining("out of range"), "bad"));
    expect(a.closeModal).not.toHaveBeenCalled();
  });
});
