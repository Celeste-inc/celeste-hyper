import { describe, it, expect } from "bun:test";
import { workloadNameFor, containerNameFor } from "./model.ts";

describe("model helpers", () => {
  it("workloadNameFor prefers an explicit workloadName for registry-pull, else the service name", () => {
    expect(workloadNameFor({ sourceType: "registry-pull", name: "svc", workloadName: "wl" } as any)).toBe("wl");
    expect(workloadNameFor({ sourceType: "registry-pull", name: "svc" } as any)).toBe("svc");
    expect(workloadNameFor({ sourceType: "r2-bundle", name: "svc" } as any)).toBe("svc");
  });

  it("containerNameFor falls back to the service name", () => {
    expect(containerNameFor({ name: "svc" } as any)).toBe("svc");
    expect(containerNameFor({ name: "svc", containerName: "c" } as any)).toBe("c");
  });
});
