export interface PodMetric {
  pod: string;
  container?: string;
  cpuMillicores: number;
  memoryMi: number;
}

export interface NodeMetric {
  node: string;
  cpuMillicores: number;
  cpuPercent: number | null;
  memoryMi: number;
  memoryPercent: number | null;
}

export interface PodMetricsSummary {
  podCount: number;
  totalCpuMillicores: number;
  totalMemoryMi: number;
  avgCpuMillicores: number;
  avgMemoryMi: number;
}

const CPU_UNIT_TO_MILLICORES: Record<string, number> = {
  n: 1 / 1_000_000,
  u: 1 / 1_000,
  m: 1,
  k: 1_000_000,
};

const MEM_UNIT_TO_MEBIBYTES: Record<string, number> = {
  Ki: 1 / 1024,
  Mi: 1,
  Gi: 1024,
  Ti: 1024 * 1024,
  Pi: 1024 * 1024 * 1024,
  K: 1000 / (1024 * 1024),
  M: (1000 * 1000) / (1024 * 1024),
  G: (1000 * 1000 * 1000) / (1024 * 1024),
};

export function parseCpuToMillicores(raw: string): number {
  const v = (raw ?? "").trim();
  if (!v || v === "<none>") return 0;
  const match = v.match(/^(\d+(?:\.\d+)?)(n|u|m|k)?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2];
  if (!unit) return Math.round(value * 1000);
  const factor = CPU_UNIT_TO_MILLICORES[unit];
  if (factor === undefined) return 0;
  const millis = value * factor;
  if (unit === "n" || unit === "u") return Number(millis.toFixed(3));
  return Math.round(millis);
}

export function parseMemoryToMebibytes(raw: string): number {
  const v = (raw ?? "").trim();
  if (!v || v === "<none>") return 0;
  const match = v.match(/^(\d+(?:\.\d+)?)([KMGTP]i?)?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2];
  if (!unit) return Math.round(value / (1024 * 1024));
  const factor = MEM_UNIT_TO_MEBIBYTES[unit];
  if (factor === undefined) return 0;
  return Math.round(value * factor);
}

function parsePercent(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)%$/);
  return m ? Number(m[1]) : null;
}

export function parseTopPods(stdout: string): PodMetric[] {
  const out: PodMetric[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^NAME\b/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length === 3) {
      const [pod, cpu, mem] = cols as [string, string, string];
      out.push({ pod, cpuMillicores: parseCpuToMillicores(cpu), memoryMi: parseMemoryToMebibytes(mem) });
    } else if (cols.length === 4) {
      const [pod, container, cpu, mem] = cols as [string, string, string, string];
      out.push({
        pod,
        container,
        cpuMillicores: parseCpuToMillicores(cpu),
        memoryMi: parseMemoryToMebibytes(mem),
      });
    }
  }
  return out;
}

export function parseTopNodes(stdout: string): NodeMetric[] {
  const out: NodeMetric[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^NAME\b/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 3) continue;
    const node = cols[0]!;
    const cpu = cols[1]!;
    let cpuPercentRaw: string | undefined;
    let memRaw: string;
    let memPercentRaw: string | undefined;
    if (cols.length >= 5) {
      cpuPercentRaw = cols[2];
      memRaw = cols[3]!;
      memPercentRaw = cols[4];
    } else {
      memRaw = cols[2]!;
    }
    out.push({
      node,
      cpuMillicores: parseCpuToMillicores(cpu),
      cpuPercent: parsePercent(cpuPercentRaw),
      memoryMi: parseMemoryToMebibytes(memRaw),
      memoryPercent: parsePercent(memPercentRaw),
    });
  }
  return out;
}

export function summarizePodMetrics(items: PodMetric[]): PodMetricsSummary {
  const podCount = items.length;
  if (podCount === 0) {
    return { podCount: 0, totalCpuMillicores: 0, totalMemoryMi: 0, avgCpuMillicores: 0, avgMemoryMi: 0 };
  }
  const totalCpuMillicores = items.reduce((s, p) => s + p.cpuMillicores, 0);
  const totalMemoryMi = items.reduce((s, p) => s + p.memoryMi, 0);
  return {
    podCount,
    totalCpuMillicores,
    totalMemoryMi,
    avgCpuMillicores: Math.round(totalCpuMillicores / podCount),
    avgMemoryMi: Math.round(totalMemoryMi / podCount),
  };
}
