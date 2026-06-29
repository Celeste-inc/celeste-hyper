import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Templates } from "./Templates";
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

describe("Templates modal", () => {
  it("renders the curated catalog", async () => {
    vi.spyOn(http, "templates").mockResolvedValue({
      status: 200,
      body: {
        items: [
          { id: "nginx", label: "NGINX", category: "web", image: "nginx", defaultTag: "1.27", defaultPort: 80, portName: "http", description: "HTTP server", env: [] },
          { id: "postgres", label: "PostgreSQL", category: "database", image: "postgres", defaultTag: "16", defaultPort: 5432, portName: "postgres", description: "DB", env: [] },
        ],
      },
    } as never);
    render(<Templates {...baseProps} />);
    await waitFor(() => expect(screen.getByText("NGINX")).toBeTruthy());
    expect(screen.getByText("PostgreSQL")).toBeTruthy();
  });

  it("clicking Deploy on a card switches to the template-deploy modal", async () => {
    vi.spyOn(http, "templates").mockResolvedValue({
      status: 200,
      body: { items: [{ id: "nginx", label: "NGINX", category: "web", image: "nginx", defaultTag: "1.27", defaultPort: 80, portName: "http", description: "x", env: [] }] },
    } as never);
    render(<Templates {...baseProps} />);
    await waitFor(() => expect(screen.getByText("NGINX")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^deploy$/i }));
    expect(baseProps.setModal).toHaveBeenCalledWith({ type: "template-deploy", templateId: "nginx" });
  });

  it("searches Docker Hub and lists the results", async () => {
    vi.spyOn(http, "templates").mockResolvedValue({ status: 200, body: { items: [] } } as never);
    const search = vi.spyOn(http, "searchDockerHub").mockResolvedValue({
      status: 200,
      body: { items: [{ name: "library/nginx", description: "Official", stars: 100, pulls: 1, official: true }] },
    } as never);
    render(<Templates {...baseProps} />);
    const input = screen.getByLabelText(/image name/i);
    fireEvent.change(input, { target: { value: "nginx" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await waitFor(() => expect(screen.getByText("library/nginx")).toBeTruthy());
    expect(search).toHaveBeenCalledWith("nginx");
    expect(screen.getByText("official")).toBeTruthy();
  });

  it("shows the Docker Hub error and clears the previous results on failure", async () => {
    vi.spyOn(http, "templates").mockResolvedValue({ status: 200, body: { items: [] } } as never);
    vi.spyOn(http, "searchDockerHub").mockResolvedValue({ status: 502, body: { error: "upstream timeout" } } as never);
    render(<Templates {...baseProps} />);
    fireEvent.change(screen.getByLabelText(/image name/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("upstream timeout"));
  });
});
