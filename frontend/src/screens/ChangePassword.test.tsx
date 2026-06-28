import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChangePassword } from "./ChangePassword";
import { http } from "../shared/api/client";

function fillAndSubmit(current: string, next: string) {
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: next } });
  fireEvent.click(screen.getByRole("button", { name: /set new password/i }));
}

describe("ChangePassword", () => {
  it("shows the error when the change is rejected", async () => {
    vi.spyOn(http, "changePassword").mockResolvedValue({ status: 401, body: { error: "current password is incorrect" } } as any);
    const onChanged = vi.fn();
    render(<ChangePassword onChanged={onChanged} />);
    fillAndSubmit("wrong", "a-new-strong-pw");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("current password is incorrect"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("calls onChanged on success", async () => {
    vi.spyOn(http, "changePassword").mockResolvedValue({ status: 200, body: { ok: true } } as any);
    const onChanged = vi.fn();
    render(<ChangePassword onChanged={onChanged} />);
    fillAndSubmit("admin", "a-new-strong-pw");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("does not submit when the confirmation differs", () => {
    const request = vi.spyOn(http, "changePassword");
    render(<ChangePassword onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-new-strong-pw" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "another-password" } });
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));
    expect(screen.getByRole("alert").textContent).toContain("do not match");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not submit a password shorter than eight characters", () => {
    const request = vi.spyOn(http, "changePassword");
    render(<ChangePassword onChanged={vi.fn()} />);
    fillAndSubmit("admin", "short");
    expect(screen.getByRole("alert").textContent).toContain("at least 8 characters");
    expect(request).not.toHaveBeenCalled();
  });
});
