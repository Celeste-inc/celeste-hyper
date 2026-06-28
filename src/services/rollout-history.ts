/** Parse `kubectl rollout history <kind>/<name>` text into ascending revision numbers. */
export function parseRolloutHistory(stdout: string): number[] {
  const revisions: number[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s/); // the REVISION column is a leading integer
    if (m) revisions.push(Number(m[1]));
  }
  return revisions.sort((a, b) => a - b);
}

/** The revision to roll back to — the one before the current (highest). Null if fewer than two. */
export function previousRevision(revisions: number[]): number | null {
  if (revisions.length < 2) return null;
  return revisions[revisions.length - 2]!;
}
