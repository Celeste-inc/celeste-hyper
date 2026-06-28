import { describe, it, expect } from "bun:test";
import { parseRolloutHistory, previousRevision } from "./rollout-history.ts";

const HISTORY = `deployment.apps/whoami
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
3         <none>
`;

describe("parseRolloutHistory", () => {
  it("extracts revision numbers in ascending order", () => {
    expect(parseRolloutHistory(HISTORY)).toEqual([1, 2, 3]);
  });

  it("ignores the title and header lines", () => {
    expect(parseRolloutHistory("statefulset.apps/db\nREVISION  CHANGE-CAUSE\n7  <none>")).toEqual([7]);
  });

  it("returns [] for empty/garbage output", () => {
    expect(parseRolloutHistory("")).toEqual([]);
    expect(parseRolloutHistory("error: no history")).toEqual([]);
  });
});

describe("previousRevision", () => {
  it("returns the revision before the highest (current)", () => {
    expect(previousRevision([1, 2, 3])).toBe(2);
  });
  it("returns null when there is only one revision", () => {
    expect(previousRevision([1])).toBeNull();
    expect(previousRevision([])).toBeNull();
  });
});
