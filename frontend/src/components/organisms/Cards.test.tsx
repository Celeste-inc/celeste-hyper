import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SkewPill } from "./Cards";

describe("SkewPill (CC.5)", () => {
  it("renders a warning with the reason when kubectl is out of skew", () => {
    render(<SkewPill skew={{ client: "v1.33.0", server: "v1.31.0", ok: false, reason: "kubectl v1.33.0 is >1 minor from server v1.31.0" }} />);
    const pill = screen.getByText("Version skew");
    expect(pill).toBeTruthy();
    expect(pill.closest("[title]")?.getAttribute("title")).toContain("minor");
  });

  it("renders nothing when versions are in range or unknown", () => {
    const { container: ok } = render(<SkewPill skew={{ client: "v1.31.0", server: "v1.31.0", ok: true, reason: null }} />);
    expect(ok.textContent).toBe("");
    const { container: missing } = render(<SkewPill skew={undefined} />);
    expect(missing.textContent).toBe("");
  });
});
