import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { IngressYaml } from "./IngressYaml";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

describe("IngressYaml modal", () => {
  it("fetches and renders the ingress YAML", async () => {
    vi.spyOn(http, "ingressYaml").mockResolvedValue({
      status: 200,
      body: { yaml: "apiVersion: networking.k8s.io/v1\nkind: Ingress" },
    } as never);
    render(<IngressYaml clusterId="primary" namespace="default" name="web" {...actions()} />);
    await waitFor(() => expect(screen.getByLabelText("ingress yaml").textContent).toContain("kind: Ingress"));
    expect(http.ingressYaml).toHaveBeenCalledWith("primary", "default", "web");
  });

  it("shows an error when the fetch is forbidden", async () => {
    vi.spyOn(http, "ingressYaml").mockResolvedValue({ status: 403, body: { error: "forbidden" } } as never);
    render(<IngressYaml clusterId="primary" namespace="default" name="web" {...actions()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("forbidden"));
  });
});
