import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NamespaceFilter, readNamespacesFromUrl, writeNamespacesToUrl, filterByNamespace } from "./NamespaceFilter";

beforeEach(() => window.history.replaceState(null, "", "/"));

describe("namespace URL persistence", () => {
  it("round-trips the ?ns= query string", () => {
    window.history.replaceState(null, "", "/?ns=prod,staging");
    expect(readNamespacesFromUrl()).toEqual(["prod", "staging"]);
    writeNamespacesToUrl(["only"]);
    expect(new URLSearchParams(window.location.search).get("ns")).toBe("only");
    writeNamespacesToUrl([]);
    expect(window.location.search).toBe("");
  });
});

describe("filterByNamespace", () => {
  it("returns all when nothing is selected, else only matching", () => {
    const items = [{ namespace: "a" }, { namespace: "b" }];
    expect(filterByNamespace(items, [])).toHaveLength(2);
    expect(filterByNamespace(items, ["a"])).toEqual([{ namespace: "a" }]);
  });
});

describe("NamespaceFilter component", () => {
  it("toggles a namespace selection via onChange", () => {
    const onChange = vi.fn();
    render(<NamespaceFilter namespaces={["prod", "staging"]} selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "prod" }));
    expect(onChange).toHaveBeenCalledWith(["prod"]);
  });

  it("renders nothing when there is at most one namespace", () => {
    const { container } = render(<NamespaceFilter namespaces={["only"]} selected={[]} onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
