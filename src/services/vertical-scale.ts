export type ResourceKey = "cpu" | "memory" | "ephemeral-storage";

export interface ResourceList {
  cpu?: string;
  memory?: string;
  "ephemeral-storage"?: string;
}

export interface ResourcesPatchInput {
  containerName: string;
  requests?: ResourceList;
  limits?: ResourceList;
}

export interface ResourcesPatch {
  spec: {
    template: {
      spec: {
        containers: Array<{
          name: string;
          resources: { requests?: ResourceList; limits?: ResourceList };
        }>;
      };
    };
  };
}

// Production-conservative caps so a typo doesn't request 256 cores. Operators that genuinely need
// more should patch the spec directly via kubectl — this UI is for the 99 % case.
const MAX_CPU_MILLICORES = 64_000;       // 64 cores
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024; // 1Ti
const MAX_STORAGE_BYTES = 4 * 1024 * 1024 * 1024 * 1024; // 4Ti

const CPU_SUFFIX_TO_MILLIS: Record<string, number> = { n: 1 / 1_000_000, u: 1 / 1_000, m: 1 };
const MEM_SUFFIX_TO_BYTES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  K: 1_000,
  M: 1_000_000,
  G: 1_000_000_000,
  T: 1_000_000_000_000,
  P: 1_000_000_000_000_000,
};

export function parseQuantity(raw: string, kind: "cpu" | "memory"): number | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (kind === "cpu") {
    const m = v.match(/^(\d+(?:\.\d+)?)(n|u|m)?$/);
    if (!m) return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) return null;
    const factor = m[2] ? CPU_SUFFIX_TO_MILLIS[m[2]] ?? null : 1000;
    if (factor === null) return null;
    return Math.round(value * factor);
  }
  // memory (and ephemeral-storage uses the same grammar)
  const m = v.match(/^(\d+(?:\.\d+)?)([KMGTPE]i?)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = m[2];
  if (!suffix) return Math.round(value);
  const factor = MEM_SUFFIX_TO_BYTES[suffix];
  if (factor === undefined) return null;
  return Math.round(value * factor);
}

function validateResource(value: string | undefined, kind: ResourceKey): string | null {
  if (value === undefined) return null;
  const parsed = parseQuantity(value, kind === "cpu" ? "cpu" : "memory");
  if (parsed === null) return `invalid ${kind} value '${value}'`;
  if (parsed <= 0) return `${kind} must be > 0 (got '${value}')`;
  if (kind === "cpu" && parsed > MAX_CPU_MILLICORES) {
    return `cpu '${value}' exceeds the safety cap (${MAX_CPU_MILLICORES} millicores = 64 cores)`;
  }
  if (kind === "memory" && parsed > MAX_MEMORY_BYTES) {
    return `memory '${value}' exceeds the safety cap (1Ti)`;
  }
  if (kind === "ephemeral-storage" && parsed > MAX_STORAGE_BYTES) {
    return `ephemeral-storage '${value}' exceeds the safety cap (4Ti)`;
  }
  return null;
}

export function validateResources(input: { requests?: ResourceList; limits?: ResourceList }): string | null {
  for (const key of ["cpu", "memory", "ephemeral-storage"] as const) {
    const err = validateResource(input.requests?.[key], key) ?? validateResource(input.limits?.[key], key);
    if (err) return err;
  }
  // Cross-check: limit ≥ request when both are set.
  for (const key of ["cpu", "memory", "ephemeral-storage"] as const) {
    const req = input.requests?.[key];
    const lim = input.limits?.[key];
    if (req === undefined || lim === undefined) continue;
    const reqQ = parseQuantity(req, key === "cpu" ? "cpu" : "memory");
    const limQ = parseQuantity(lim, key === "cpu" ? "cpu" : "memory");
    if (reqQ !== null && limQ !== null && limQ < reqQ) {
      return `limit ${key} '${lim}' is below the matching request '${req}'`;
    }
  }
  return null;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export function buildResourcesPatch(input: ResourcesPatchInput): ResourcesPatch {
  const resources: { requests?: ResourceList; limits?: ResourceList } = {};
  if (input.requests && Object.values(input.requests).some((v) => v !== undefined)) {
    resources.requests = omitUndefined(input.requests as Record<string, unknown>) as ResourceList;
  }
  if (input.limits && Object.values(input.limits).some((v) => v !== undefined)) {
    resources.limits = omitUndefined(input.limits as Record<string, unknown>) as ResourceList;
  }
  return {
    spec: {
      template: {
        spec: {
          containers: [{ name: input.containerName, resources }],
        },
      },
    },
  };
}
