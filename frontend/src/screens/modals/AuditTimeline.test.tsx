import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AuditTimeline } from "./AuditTimeline";
import { http } from "../../shared/api/client";

const actions = () => ({ setModal: vi.fn(), closeModal: vi.fn(), notify: vi.fn(), load: vi.fn() });

const row = (over: Record<string, unknown>) => ({
  id: 1,
  ts: "2026-01-01T00:00:00Z",
  actor: "alice",
  role: "admin",
  action: "job:deploy",
  resource_kind: "service",
  resource_id: "hello",
  payload: null,
  result: "ok",
  message: null,
  ...over,
});

const page1 = { status: 200, body: { items: [row({ id: 1, actor: "alice" })], nextCursor: "CURSOR2" } };
const page2 = { status: 200, body: { items: [row({ id: 2, actor: "bob", action: "POST /api/services/hello/deploy" })], nextCursor: null } };

describe("AuditTimeline modal", () => {
  it("renders rows from the first page", async () => {
    vi.spyOn(http, "audit").mockResolvedValue(page1 as never);
    render(<AuditTimeline {...actions()} />);
    await waitFor(() => expect(screen.getByText("alice")).toBeTruthy());
    expect(screen.getByText("job:deploy")).toBeTruthy();
    expect(screen.getByText("service/hello")).toBeTruthy();
  });

  it("shows Load more and appends the next page", async () => {
    const spy = vi.spyOn(http, "audit").mockResolvedValueOnce(page1 as never).mockResolvedValueOnce(page2 as never);
    render(<AuditTimeline {...actions()} />);
    await waitFor(() => screen.getByText("alice"));
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText("bob")).toBeTruthy());
    expect(screen.getByText("alice")).toBeTruthy();
    expect(spy).toHaveBeenLastCalledWith(expect.stringContaining("cursor=CURSOR2"));
  });

  it("re-queries from page 1 when a result filter is applied", async () => {
    const spy = vi.spyOn(http, "audit").mockResolvedValue(page1 as never);
    render(<AuditTimeline {...actions()} />);
    await waitFor(() => screen.getByText("alice"));
    fireEvent.change(screen.getByLabelText("Result"), { target: { value: "fail" } });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy).toHaveBeenLastCalledWith("result=fail");
  });
});
