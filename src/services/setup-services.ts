import { existsSync } from "node:fs";
import type { ApiDeps } from "../routes/deps.ts";
import * as envFiles from "../lib/env-files.ts";
import type { ServiceConfig } from "../config.ts";
import type { ServiceModel } from "./model.ts";

export interface SetupServiceTemplate {
  name: string;
  label: string;
  r2Prefix: string;
  configEnv: string;
  secretEnv: string;
}

export interface BootstrapServiceInput {
  name: string;
  r2Prefix: string;
  namespace?: string;
  configEnv?: string;
  secretEnv?: string;
  manifestRoot?: string;
  imageTarPattern?: string;
  imageRefPrefix?: string;
}

export interface BootstrapResult {
  service: string;
  action: "created" | "updated" | "skipped";
  env: { config: "created" | "kept" | "empty"; secret: "created" | "kept" | "empty" };
}

export function setupServiceTemplates(deps: ApiDeps): Array<SetupServiceTemplate & { registered: boolean; currentTag: string | null; service: ServiceModel | null }> {
  return deps.cfg.services.map((svc) => {
    const service = deps.registry.get(svc.name);
    const current = deps.state.getCurrent(svc.name);
    return {
      name: svc.name,
      label: svc.name,
      r2Prefix: svc.r2Prefix,
      configEnv: "",
      secretEnv: "",
      registered: Boolean(service),
      currentTag: current?.tag ?? null,
      service,
    };
  });
}

export async function bootstrapSetupServices(
  deps: ApiDeps,
  input: {
    clusterId: string;
    namespace: string;
    services: BootstrapServiceInput[];
    r2SourceId?: string;
    writeEnvTemplates: boolean;
    overwriteEnvTemplates: boolean;
  },
): Promise<BootstrapResult[]> {
  const results: BootstrapResult[] = [];

  for (const service of input.services) {
    const spec: ServiceModel = {
      sourceType: "r2-bundle",
      name: service.name,
      namespace: service.namespace || input.namespace,
      clusterId: input.clusterId,
      r2SourceId: input.r2SourceId || "default",
      r2Prefix: service.r2Prefix,
      manifestRoot: service.manifestRoot || "k8s",
      imageTarPattern: service.imageTarPattern || "{name}-{tag}-amd64.tar",
      imageRefPrefix: service.imageRefPrefix || "docker.io/library",
      enabled: true,
    };

    const existing = deps.registry.get(service.name);
    let action: BootstrapResult["action"] = "skipped";
    if (!existing) {
      deps.registry.create(spec);
      action = "created";
    } else if (existing.sourceType === "r2-bundle") {
      deps.registry.update(service.name, spec);
      action = "updated";
    }

    results.push({
      service: service.name,
      action,
      env: input.writeEnvTemplates
        ? {
            config: await writeTemplate(deps.cfg.envFilesDir, service.name, "config", service.configEnv ?? "", input.overwriteEnvTemplates),
            secret: await writeTemplate(deps.cfg.envFilesDir, service.name, "secret", service.secretEnv ?? "", input.overwriteEnvTemplates),
          }
        : { config: "empty", secret: "empty" },
    });
  }

  return results;
}

export function serviceInputFromConfig(svc: ServiceConfig, namespace: string): BootstrapServiceInput {
  return {
    name: svc.name,
    namespace: svc.namespace || namespace,
    r2Prefix: svc.r2Prefix,
    manifestRoot: svc.manifestRoot,
    imageTarPattern: svc.imageTarPattern,
    imageRefPrefix: svc.imageRefPrefix,
    configEnv: "",
    secretEnv: "",
  };
}

async function writeTemplate(root: string, service: string, kind: envFiles.EnvKind, content: string, overwrite: boolean): Promise<"created" | "kept" | "empty"> {
  const path = envFiles.pathFor(root, service, kind);
  if (existsSync(path) && !overwrite) return "kept";
  await envFiles.write(root, service, kind, content);
  return "created";
}
