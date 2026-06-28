import type { R2Config } from "../lib/r2.ts";
import { R2 } from "../lib/r2.ts";
import type { R2Like } from "../lib/r2-port.ts";
import type { State } from "../lib/state.ts";

export const DEFAULT_R2_SOURCE_ID = "default";

const KEYS = {
  endpoint: "settings.r2.endpoint",
  bucket: "settings.r2.bucket",
  accessKeyId: "settings.r2.accessKeyId",
  secretAccessKey: "settings.r2.secretAccessKey",
  region: "settings.r2.region",
  sources: "settings.r2.sources",
} as const;

export interface R2SourceConfig extends R2Config {
  id: string;
  name: string;
}

export interface R2SourceSummary {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  region: string;
  secretConfigured: boolean;
}

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

export function effectiveR2Config(state: State, fallback: R2Config): R2Config {
  return {
    endpoint: state.getMeta(KEYS.endpoint) ?? fallback.endpoint,
    bucket: state.getMeta(KEYS.bucket) ?? fallback.bucket,
    accessKeyId: state.getMeta(KEYS.accessKeyId) ?? fallback.accessKeyId,
    secretAccessKey: state.getMeta(KEYS.secretAccessKey) ?? fallback.secretAccessKey,
    region: state.getMeta(KEYS.region) ?? fallback.region,
  };
}

export function saveR2Config(state: State, cfg: R2Config): void {
  state.setMeta(KEYS.endpoint, cfg.endpoint);
  state.setMeta(KEYS.bucket, cfg.bucket);
  state.setMeta(KEYS.accessKeyId, cfg.accessKeyId);
  state.setMeta(KEYS.secretAccessKey, cfg.secretAccessKey);
  state.setMeta(KEYS.region, cfg.region);
}

export function summarizeR2Source(source: R2SourceConfig): R2SourceSummary {
  return {
    id: source.id,
    name: source.name,
    endpoint: source.endpoint,
    bucket: source.bucket,
    accessKeyId: source.accessKeyId,
    region: source.region,
    secretConfigured: source.secretAccessKey.length > 0,
  };
}

function defaultSource(state: State, fallback: R2Config): R2SourceConfig {
  return { id: DEFAULT_R2_SOURCE_ID, name: "Default R2", ...effectiveR2Config(state, fallback) };
}

function parseSources(raw: string | null): R2SourceConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as R2SourceConfig[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((source) => source.id && source.name && source.endpoint && source.bucket && source.accessKeyId && source.secretAccessKey && source.region);
  } catch {
    return [];
  }
}

function saveSources(state: State, sources: R2SourceConfig[]): void {
  state.setMeta(KEYS.sources, JSON.stringify(sources));
  const def = sources.find((source) => source.id === DEFAULT_R2_SOURCE_ID);
  if (def) saveR2Config(state, def);
}

export class R2SourceStore {
  constructor(private readonly state: State, private readonly fallback: R2Config, private readonly defaultClient?: R2Like) {}

  list(): R2SourceConfig[] {
    const sources = parseSources(this.state.getMeta(KEYS.sources));
    const def = defaultSource(this.state, this.fallback);
    const withoutDefault = sources.filter((source) => source.id !== DEFAULT_R2_SOURCE_ID);
    return [sources.find((source) => source.id === DEFAULT_R2_SOURCE_ID) ?? def, ...withoutDefault];
  }

  summaries(): R2SourceSummary[] {
    return this.list().map(summarizeR2Source);
  }

  get(id?: string): R2SourceConfig {
    const sourceId = id || DEFAULT_R2_SOURCE_ID;
    return this.list().find((source) => source.id === sourceId) ?? this.list()[0]!;
  }

  clientFor(id?: string): R2Like {
    const source = this.get(id);
    if (source.id === DEFAULT_R2_SOURCE_ID && this.defaultClient) return this.defaultClient;
    return new R2(source);
  }

  upsert(input: R2SourceConfig): R2SourceConfig {
    if (!SOURCE_ID_RE.test(input.id)) throw new Error("invalid source id");
    const current = this.list();
    const next = [input, ...current.filter((source) => source.id !== input.id)].sort((a, b) => (a.id === DEFAULT_R2_SOURCE_ID ? -1 : b.id === DEFAULT_R2_SOURCE_ID ? 1 : a.id.localeCompare(b.id)));
    saveSources(this.state, next);
    if (input.id === DEFAULT_R2_SOURCE_ID) {
      this.defaultClient?.updateConfig(input);
      Object.assign(this.fallback, input);
    }
    return input;
  }

  delete(id: string, inUse: (id: string) => boolean): boolean {
    if (id === DEFAULT_R2_SOURCE_ID) throw new Error("default source cannot be deleted");
    if (inUse(id)) throw new Error(`R2 source '${id}' is still used by a service`);
    const current = this.list();
    const next = current.filter((source) => source.id !== id);
    if (next.length === current.length) return false;
    saveSources(this.state, next);
    return true;
  }
}
