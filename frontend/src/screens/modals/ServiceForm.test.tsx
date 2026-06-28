import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ServiceForm } from "./ServiceForm";
import { http } from "../../shared/api/client";
import type { Cluster } from "../../shared/types/api";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });
const clusters: Cluster[] = [{ id: "c1", name: "Edge", defaultNamespace: "default", runtime: "auto", enabled: true, serviceCount: 0 }];

describe("ServiceForm modal — git-sync", () => {
  it("reveals the Git URL field and submits a git-sync create body", async () => {
    const create = vi.spyOn(http, "createService").mockResolvedValue({ status: 201, body: {} } as never);
    render(<ServiceForm clusters={clusters} {...actions()} />);
    fireEvent.change(screen.getByLabelText("Image source"), { target: { value: "git-sync" } });
    fireEvent.change(screen.getByLabelText("Git URL"), { target: { value: "https://github.com/acme/repo.git" } });
    fireEvent.change(screen.getByLabelText("Service name"), { target: { value: "infra" } });
    fireEvent.click(screen.getByRole("button", { name: /create service/i }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "git-sync", gitUrl: "https://github.com/acme/repo.git", gitRef: "main", gitPath: "." })));
  });
});
