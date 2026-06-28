import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Login } from "./Login";
import { http } from "../shared/api/client";

function fillAndSubmit(user: string, pass: string) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: pass } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("Login", () => {
  it("shows the error message on bad credentials and does not authenticate", async () => {
    vi.spyOn(http, "login").mockResolvedValue({ status: 401, body: { error: "invalid credentials" } } as any);
    const onAuthed = vi.fn();
    render(<Login onAuthed={onAuthed} />);
    fillAndSubmit("alice", "wrong");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("invalid credentials"));
    expect(onAuthed).not.toHaveBeenCalled();
  });

  it("calls onAuthed on successful login", async () => {
    vi.spyOn(http, "login").mockResolvedValue({
      status: 200,
      body: { username: "alice", role: "admin", mustChangePassword: false, token: "t" },
    } as any);
    const onAuthed = vi.fn();
    render(<Login onAuthed={onAuthed} />);
    fillAndSubmit("alice", "right");
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  });
});
