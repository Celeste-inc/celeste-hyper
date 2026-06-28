import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./lib/logger.ts";

const ServiceSchema = z.object({
  name: z.string().min(1),
  r2Prefix: z.string().min(1),
  namespace: z.string().default("default"),
  manifestRoot: z.string().default("k8s"),
  imageTarPattern: z.string().default("{name}-{tag}-amd64.tar"),
  installScript: z.string().default("install.sh"),
  imageRefPrefix: z.string().default("docker.io/library"),
});

export type ServiceConfig = z.infer<typeof ServiceSchema>;

const ListenSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(8080),
});
const K8sSchema = z.object({
  kubeconfig: z.string().optional(),
  runtime: z.enum(["k3s", "docker", "containerd", "auto"]).default("auto"),
  namespace: z.string().default("default"),
});
const PollerSchema = z.object({
  intervalSec: z.number().int().min(5).default(60),
  autoDeploy: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const ConfigSchema = z.object({
  listen: ListenSchema.default({ host: "0.0.0.0", port: 8080 }),
  r2: z.object({
    endpoint: z.string().url(),
    bucket: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    region: z.string().default("auto"),
  }),
  k8s: K8sSchema.default({ runtime: "auto", namespace: "default" }),
  stateDir: z.string().default("/var/lib/celeste-hyper"),
  envFilesDir: z.string().default("/etc/celeste-hyper/services"),
  workDir: z.string().default("/var/lib/celeste-hyper/work"),
  // git-sync (P2.3). An empty `hostAllowlist` disables git-sync entirely (service create is refused).
  git: z
    .object({
      hostAllowlist: z.array(z.string()).default([]),
      keysDir: z.string().default("/etc/celeste-hyper/git-keys"),
    })
    .default({ hostAllowlist: [], keysDir: "/etc/celeste-hyper/git-keys" }),
  poller: PollerSchema.default({ intervalSec: 60, autoDeploy: false, enabled: true }),
  services: z.array(ServiceSchema).default([]),
  clusters: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    kubeconfigPath: z.string().default(""),
    defaultNamespace: z.string().default("default"),
    runtime: z.enum(["k3s", "docker", "containerd", "auto"]).default("auto"),
  })).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function envOverride(cfg: unknown): unknown {
  if (typeof cfg !== "object" || cfg === null) return cfg;
  const c = cfg as Record<string, any>;
  c.r2 = c.r2 ?? {};
  if (Bun.env.R2_ENDPOINT_URL) c.r2.endpoint = Bun.env.R2_ENDPOINT_URL;
  if (Bun.env.R2_BUCKET) c.r2.bucket = Bun.env.R2_BUCKET;
  if (Bun.env.R2_ACCESS_KEY_ID) c.r2.accessKeyId = Bun.env.R2_ACCESS_KEY_ID;
  if (Bun.env.R2_SECRET_ACCESS_KEY) c.r2.secretAccessKey = Bun.env.R2_SECRET_ACCESS_KEY;
  if (Bun.env.HYPER_LISTEN_PORT) {
    c.listen = c.listen ?? {};
    c.listen.port = Number(Bun.env.HYPER_LISTEN_PORT);
  }
  if (Bun.env.HYPER_STATE_DIR) c.stateDir = Bun.env.HYPER_STATE_DIR;
  if (Bun.env.HYPER_ENV_FILES_DIR) c.envFilesDir = Bun.env.HYPER_ENV_FILES_DIR;
  c.git = c.git ?? {};
  if (Bun.env.HYPER_GIT_HOST_ALLOWLIST !== undefined) {
    c.git.hostAllowlist = Bun.env.HYPER_GIT_HOST_ALLOWLIST.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  }
  if (Bun.env.HYPER_GIT_KEYS_DIR) c.git.keysDir = Bun.env.HYPER_GIT_KEYS_DIR;
  return c;
}

export function loadConfig(): Config {
  const candidates = [
    Bun.env.HYPER_CONFIG,
    "./config.json",
    "/etc/celeste-hyper/config.json",
  ].filter((p): p is string => Boolean(p));

  let raw: unknown = {};
  let source: string | null = null;
  for (const p of candidates) {
    const abs = resolve(p);
    if (existsSync(abs)) {
      raw = JSON.parse(readFileSync(abs, "utf8"));
      source = abs;
      break;
    }
  }
  if (!source) log.warn("config.no_file_found", { tried: candidates });

  const withEnv = envOverride(raw);
  const result = ConfigSchema.safeParse(withEnv);
  if (!result.success) {
    log.error("config.invalid", { issues: result.error.issues });
    throw new Error(`invalid config: ${result.error.message}`);
  }
  log.info("config.loaded", { source, services: result.data.services.length });
  return result.data;
}
