import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Env } from "./Env";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn().mockResolvedValue(undefined) });

function mockEnv(body: Record<string, unknown>) {
  vi.spyOn(http, "env").mockResolvedValue({ status: 200, body: { path: "/x", exists: true, keys: [], rows: [], ...body } } as never);
}

describe("Env modal (row editor)", () => {
  it("adding a variable creates a new row", async () => {
    mockEnv({ keys: [], rows: [], content: "" });
    render(<Env name="svc" kind="config" {...actions()} />);
    await waitFor(() => screen.getByRole("button", { name: /Add variable/i }));
    expect(screen.queryByLabelText("key 0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add variable/i }));
    expect(screen.getByLabelText("key 0")).toBeTruthy();
  });

  it("paste-import populates rows from raw dotenv", async () => {
    mockEnv({ keys: [], rows: [], content: "" });
    render(<Env name="svc" kind="config" {...actions()} />);
    await waitFor(() => screen.getByRole("button", { name: /^Import$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }));
    fireEvent.change(screen.getByLabelText("Dotenv content"), { target: { value: "A=1\nB=2" } });
    fireEvent.click(screen.getByRole("button", { name: /Replace variables/i }));
    expect((screen.getByLabelText("key 0") as HTMLInputElement).value).toBe("A");
    expect((screen.getByLabelText("key 1") as HTMLInputElement).value).toBe("B");
  });

  it("removing a key prompts for confirmation before saving", async () => {
    mockEnv({ keys: ["A"], content: "A=1\n" });
    const saveRows = vi.spyOn(http, "saveEnvRows").mockResolvedValue({ status: 200, body: { ok: true, stripped: [] } } as never);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Env name="svc" kind="config" {...actions()} />);
    await waitFor(() => screen.getByLabelText("key 0"));
    fireEvent.click(screen.getByRole("button", { name: /remove A/i }));
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(confirm).toHaveBeenCalled();
    expect(saveRows).not.toHaveBeenCalled(); // confirm returned false → aborted
  });

  it("secret values are password fields by default and reveal toggles them", async () => {
    mockEnv({ keys: ["API_KEY"], rows: [{ key: "API_KEY" }] });
    render(<Env name="svc" kind="secret" {...actions()} />);
    await waitFor(() => screen.getByLabelText("value 0"));
    expect((screen.getByLabelText("value 0") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /Show values/i }));
    expect((screen.getByLabelText("value 0") as HTMLInputElement).type).toBe("text");
  });

  it("blocks duplicate variable names before saving", async () => {
    mockEnv({ keys: [], rows: [], content: "" });
    const props = actions();
    const saveRows = vi.spyOn(http, "saveEnvRows");
    render(<Env name="svc" kind="config" {...props} />);
    await waitFor(() => screen.getByRole("button", { name: /Add variable/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add variable/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add variable/i }));
    fireEvent.change(screen.getByLabelText("key 0"), { target: { value: "PORT" } });
    fireEvent.change(screen.getByLabelText("key 1"), { target: { value: "PORT" } });
    expect(screen.getAllByText("Variable names must be unique.")).toHaveLength(2);
    expect((screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(saveRows).not.toHaveBeenCalled();
  });
});
