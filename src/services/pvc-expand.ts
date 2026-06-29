import { parseQuantity } from "./vertical-scale.ts";

const MAX_PVC_BYTES = 4 * 1024 * 1024 * 1024 * 1024; // 4Ti per volume — production safety cap.

export interface PvcExpandInput {
  from: string;
  to: string;
  /** Whether the bound StorageClass has allowVolumeExpansion: true. Null = unknown. */
  expandable?: boolean | null;
}

export function validatePvcExpand(input: PvcExpandInput): string | null {
  if (input.expandable === false) {
    return "the bound StorageClass does not set allowVolumeExpansion: true — online resize is not possible";
  }
  const fromBytes = parseQuantity(input.from, "memory");
  const toBytes = parseQuantity(input.to, "memory");
  if (fromBytes === null) return `current value '${input.from}' is unparseable`;
  if (toBytes === null) return `target value '${input.to}' is unparseable`;
  if (toBytes <= fromBytes) {
    return `target ${input.to} must be strictly larger than the current ${input.from} (k8s PVCs cannot shrink online)`;
  }
  if (toBytes > MAX_PVC_BYTES) {
    return `target ${input.to} exceeds the safety cap (4Ti); resize in smaller increments or patch the spec directly`;
  }
  return null;
}

export interface PvcExpandPatch {
  spec: { resources: { requests: { storage: string } } };
}

export function buildPvcExpandPatch(toSize: string): PvcExpandPatch {
  return { spec: { resources: { requests: { storage: toSize } } } };
}
