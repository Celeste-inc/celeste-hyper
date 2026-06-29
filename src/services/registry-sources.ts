import type { State } from "../lib/state.ts";
import type { RegistryPresetId } from "./registry-presets.ts";

const META_KEY = "settings.registries.sources";
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

export interface RegistrySource {
  id: string;
  name: string;
  presetId: RegistryPresetId;
  registry?: string;
  region?: string;
  username: string;
  password: string;
  email?: string;
}

export interface RegistrySourceInput {
  id: string;
  name: string;
  presetId: RegistryPresetId;
  registry?: string;
  region?: string;
  username: string;
  /** Omit on update to preserve the previously stored value (PATCH-style). */
  password?: string;
  email?: string;
}

export interface RegistrySourceSummary {
  id: string;
  name: string;
  presetId: RegistryPresetId;
  registry?: string;
  region?: string;
  username: string;
  email?: string;
  secretConfigured: boolean;
}

function summarize(source: RegistrySource): RegistrySourceSummary {
  return {
    id: source.id,
    name: source.name,
    presetId: source.presetId,
    registry: source.registry,
    region: source.region,
    username: source.username,
    email: source.email,
    secretConfigured: source.password.length > 0,
  };
}

function parseSources(raw: string | null): RegistrySource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RegistrySource[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) => s && typeof s.id === "string" && typeof s.password === "string" && s.password.length > 0,
    );
  } catch {
    return [];
  }
}

export class RegistrySourceStore {
  constructor(private readonly state: State) {}

  /** All stored sources, sorted by id. */
  private all(): RegistrySource[] {
    return parseSources(this.state.getMeta(META_KEY)).sort((a, b) => a.id.localeCompare(b.id));
  }

  list(): RegistrySourceSummary[] {
    return this.all().map(summarize);
  }

  /** Full record (includes password). For internal use — never expose via the API. */
  get(id: string): RegistrySource | null {
    return this.all().find((s) => s.id === id) ?? null;
  }

  upsert(input: RegistrySourceInput): RegistrySourceSummary {
    if (!SOURCE_ID_RE.test(input.id)) throw new Error(`invalid id '${input.id}' (lowercase letters, digits, '.', '-')`);
    if (!input.name.trim()) throw new Error("name is required");
    const existing = this.get(input.id);
    if (input.password === undefined && !existing) throw new Error("password is required on first create");
    const next: RegistrySource = {
      id: input.id,
      name: input.name,
      presetId: input.presetId,
      registry: input.registry,
      region: input.region,
      username: input.username,
      password: input.password ?? existing!.password,
      email: input.email,
    };
    const list = this.all().filter((s) => s.id !== input.id);
    list.push(next);
    list.sort((a, b) => a.id.localeCompare(b.id));
    this.state.setMeta(META_KEY, JSON.stringify(list));
    return summarize(next);
  }

  delete(id: string, inUse: (id: string) => boolean): boolean {
    if (inUse(id)) throw new Error(`registry source '${id}' is in use by a service`);
    const list = this.all();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return false;
    this.state.setMeta(META_KEY, JSON.stringify(next));
    return true;
  }
}
