import type { ExposeConfig } from "./model.ts";

export const NODEPORT_RANGE: readonly [number, number] = [30000, 32767];
export const SERVICE_PORT_RANGE: readonly [number, number] = [1024, 65535];

export interface AllocatePortInput {
  desired: number;
  used: ReadonlySet<number>;
  range: readonly [number, number];
  exclude?: ReadonlySet<number>;
}

export interface AllocatePortResult {
  port: number;
  reassigned: boolean;
  originalPort?: number;
}

export interface ClusterPortState {
  nodePortsInUse: Set<number>;
  servicePortsByNamespace: Map<string, Set<number>>;
}

export interface PortConflict {
  kind: "service-port" | "node-port";
  namespace?: string;
  original: number;
  reassigned: number;
}

export interface AllocateExposeResult {
  expose: ExposeConfig;
  conflicts: PortConflict[];
}

function isTaken(port: number, used: ReadonlySet<number>, exclude?: ReadonlySet<number>): boolean {
  return used.has(port) || (exclude?.has(port) ?? false);
}

export function allocatePort(input: AllocatePortInput): AllocatePortResult | null {
  const [lo, hi] = input.range;
  const inRange = input.desired >= lo && input.desired <= hi;
  if (inRange && !isTaken(input.desired, input.used, input.exclude)) {
    return { port: input.desired, reassigned: false };
  }
  // Sweep upward from desired (or from lo if desired is out of range), then wrap.
  const start = inRange ? input.desired : lo;
  const total = hi - lo + 1;
  for (let i = 0; i < total; i++) {
    const candidate = lo + ((start - lo + i) % total);
    if (!isTaken(candidate, input.used, input.exclude)) {
      if (!inRange) {
        return { port: candidate, reassigned: true, originalPort: input.desired };
      }
      if (candidate === input.desired) {
        // Already handled above, but keeps the loop self-consistent.
        return { port: candidate, reassigned: false };
      }
      return { port: candidate, reassigned: true, originalPort: input.desired };
    }
  }
  return null;
}

export function allocateExposePorts(
  desired: ExposeConfig,
  namespace: string,
  cluster: ClusterPortState,
): AllocateExposeResult {
  const conflicts: PortConflict[] = [];
  const out: ExposeConfig = { ...desired };

  const nsPorts = cluster.servicePortsByNamespace.get(namespace) ?? new Set<number>();
  const portResult = allocatePort({
    desired: desired.port,
    used: nsPorts,
    range: SERVICE_PORT_RANGE,
  });
  if (!portResult) {
    throw new Error(`no free service port available in namespace '${namespace}'`);
  }
  out.port = portResult.port;
  if (portResult.reassigned) {
    conflicts.push({
      kind: "service-port",
      namespace,
      original: portResult.originalPort ?? desired.port,
      reassigned: portResult.port,
    });
  }

  // NodePort/LoadBalancer expose an external NodePort; ClusterIP ignores nodePort entirely.
  const wantsNodePort = desired.type === "NodePort" || desired.type === "LoadBalancer";
  if (wantsNodePort) {
    const desiredNodePort = desired.nodePort ?? NODEPORT_RANGE[0];
    const nodePortResult = allocatePort({
      desired: desiredNodePort,
      used: cluster.nodePortsInUse,
      range: NODEPORT_RANGE,
    });
    if (!nodePortResult) {
      throw new Error("no free NodePort available in cluster");
    }
    out.nodePort = nodePortResult.port;
    // If the operator didn't specify a NodePort and the auto pick differs, that's not a "conflict"
    // — it's an assignment. Only flag a conflict when the operator's explicit pick was bumped.
    if (desired.nodePort !== undefined && nodePortResult.reassigned) {
      conflicts.push({
        kind: "node-port",
        original: desired.nodePort,
        reassigned: nodePortResult.port,
      });
    }
  } else {
    // ClusterIP: nodePort field is meaningless; drop it to keep the manifest clean.
    delete out.nodePort;
  }

  return { expose: out, conflicts };
}
