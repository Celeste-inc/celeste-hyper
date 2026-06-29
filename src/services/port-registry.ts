import type { ClusterPortState } from "./port-allocator.ts";

interface RawServicePort {
  name?: string;
  port: number;
  targetPort?: number | string;
  nodePort?: number;
  protocol?: string;
}

interface RawService {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    type?: string;
    clusterIP?: string;
    ports?: RawServicePort[];
  };
}

export interface RawServiceList {
  items: RawService[];
}

export interface PortAllocationRow {
  service: string;
  namespace: string;
  type: string;
  portName?: string;
  port: number;
  targetPort?: number | string;
  nodePort?: number;
  protocol: string;
  clusterIP?: string;
}

export function aggregateClusterPorts(list: RawServiceList): ClusterPortState {
  const nodePortsInUse = new Set<number>();
  const servicePortsByNamespace = new Map<string, Set<number>>();
  for (const svc of list.items ?? []) {
    const ns = svc.metadata?.namespace ?? "default";
    let bucket = servicePortsByNamespace.get(ns);
    if (!bucket) {
      bucket = new Set<number>();
      servicePortsByNamespace.set(ns, bucket);
    }
    for (const p of svc.spec?.ports ?? []) {
      if (typeof p.port === "number") bucket.add(p.port);
      if (typeof p.nodePort === "number") nodePortsInUse.add(p.nodePort);
    }
  }
  return { nodePortsInUse, servicePortsByNamespace };
}

export function listClusterPortAllocations(list: RawServiceList): PortAllocationRow[] {
  const rows: PortAllocationRow[] = [];
  for (const svc of list.items ?? []) {
    const name = svc.metadata?.name ?? "";
    const ns = svc.metadata?.namespace ?? "default";
    const type = svc.spec?.type ?? "ClusterIP";
    const clusterIP = svc.spec?.clusterIP;
    for (const p of svc.spec?.ports ?? []) {
      rows.push({
        service: name,
        namespace: ns,
        type,
        portName: p.name,
        port: p.port,
        targetPort: p.targetPort,
        nodePort: p.nodePort,
        protocol: p.protocol ?? "TCP",
        clusterIP,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
    if (a.service !== b.service) return a.service.localeCompare(b.service);
    return a.port - b.port;
  });
  return rows;
}
