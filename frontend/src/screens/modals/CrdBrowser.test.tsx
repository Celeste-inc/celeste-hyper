import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CrdBrowser } from "./CrdBrowser";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

const crd = { name: "certificates.cert-manager.io", group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", scope: "Namespaced", namespaced: true };
const obj = { name: "web-cert", namespace: "default", createdAt: "2026-01-01T00:00:00Z" };

describe("CrdBrowser modal", () => {
  it("renders the CRD list", async () => {
    vi.spyOn(http, "crds").mockResolvedValue({ status: 200, body: { items: [crd] } } as never);
    render(<CrdBrowser clusterId="primary" {...actions()} />);
    await waitFor(() => expect(screen.getByText("Certificate")).toBeTruthy());
    expect(screen.getByText("Namespaced")).toBeTruthy();
    expect(http.crds).toHaveBeenCalledWith("primary");
  });

  it("loads objects when a CRD is selected", async () => {
    vi.spyOn(http, "crds").mockResolvedValue({ status: 200, body: { items: [crd] } } as never);
    const objSpy = vi.spyOn(http, "crObjects").mockResolvedValue({ status: 200, body: { items: [obj] } } as never);
    render(<CrdBrowser clusterId="primary" {...actions()} />);
    await waitFor(() => screen.getByText("Certificate"));
    fireEvent.click(screen.getByText("Certificate"));
    await waitFor(() => expect(screen.getByText("web-cert")).toBeTruthy());
    expect(objSpy).toHaveBeenCalledWith("primary", "certificates.cert-manager.io", undefined);
  });

  it("loads YAML when an object is selected", async () => {
    vi.spyOn(http, "crds").mockResolvedValue({ status: 200, body: { items: [crd] } } as never);
    vi.spyOn(http, "crObjects").mockResolvedValue({ status: 200, body: { items: [obj] } } as never);
    const yamlSpy = vi.spyOn(http, "crYaml").mockResolvedValue({ status: 200, body: { yaml: "apiVersion: cert-manager.io/v1\nkind: Certificate" } } as never);
    render(<CrdBrowser clusterId="primary" {...actions()} />);
    await waitFor(() => screen.getByText("Certificate"));
    fireEvent.click(screen.getByText("Certificate"));
    await waitFor(() => screen.getByText("web-cert"));
    fireEvent.click(screen.getByText("web-cert"));
    await waitFor(() => expect(screen.getByLabelText("custom resource yaml").textContent).toContain("kind: Certificate"));
    expect(yamlSpy).toHaveBeenCalledWith("primary", "certificates.cert-manager.io", "web-cert", "default");
  });
});
