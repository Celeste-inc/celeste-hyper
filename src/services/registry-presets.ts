export interface RegistryAuthShape {
  usernameLabel: string;
  passwordLabel: string;
  hint?: string;
}

export interface RegistryPreset {
  id: RegistryPresetId;
  label: string;
  /** Hostname template. `{registry}` substituted at compose time for tenant-scoped registries. */
  host: string;
  /** Concrete example for the UI hint. */
  hostExample: string;
  /** docker-config auths key. May contain `{registry}`. */
  authsKey: string;
  /** True when `host` (and `authsKey`) require a `{registry}` substitution. */
  requiresRegistry: boolean;
  /** Some registries (Docker Hub) don't put the host in the image ref. */
  omitHostInImageRef: boolean;
  auth: RegistryAuthShape;
}

export type RegistryPresetId = "ghcr" | "acr" | "docker-hub" | "quay" | "harbor" | "ecr";

export const REGISTRY_PRESETS: readonly RegistryPreset[] = [
  {
    id: "acr",
    label: "Azure Container Registry",
    host: "{registry}.azurecr.io",
    hostExample: "celeste.azurecr.io",
    authsKey: "{registry}.azurecr.io",
    requiresRegistry: true,
    omitHostInImageRef: false,
    auth: {
      usernameLabel: "Service principal id / registry username",
      passwordLabel: "Service principal secret / registry password",
      hint: "Use a Service Principal with AcrPull or an enabled admin user.",
    },
  },
  {
    id: "docker-hub",
    label: "Docker Hub",
    host: "docker.io",
    hostExample: "docker.io/library/nginx",
    authsKey: "https://index.docker.io/v1/",
    requiresRegistry: false,
    omitHostInImageRef: true,
    auth: {
      usernameLabel: "Docker Hub username",
      passwordLabel: "Personal access token",
      hint: "Generate a PAT under Account Settings → Security.",
    },
  },
  {
    id: "ecr",
    label: "Amazon ECR",
    host: "{registry}.dkr.ecr.{region}.amazonaws.com",
    hostExample: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
    authsKey: "{registry}.dkr.ecr.{region}.amazonaws.com",
    requiresRegistry: true,
    omitHostInImageRef: false,
    auth: {
      usernameLabel: "AWS (constant) — username is 'AWS'",
      passwordLabel: "ECR auth token (aws ecr get-login-password)",
      hint: "Token expires after 12 hours — rotate via the AWS provider.",
    },
  },
  {
    id: "ghcr",
    label: "GitHub Container Registry",
    host: "ghcr.io",
    hostExample: "ghcr.io/celeste-inc/api",
    authsKey: "ghcr.io",
    requiresRegistry: false,
    omitHostInImageRef: false,
    auth: {
      usernameLabel: "GitHub username",
      passwordLabel: "GitHub personal access token (read:packages)",
      hint: "Use a fine-grained PAT scoped to read:packages on this org.",
    },
  },
  {
    id: "harbor",
    label: "Harbor",
    host: "{registry}",
    hostExample: "harbor.internal.example.com",
    authsKey: "{registry}",
    requiresRegistry: true,
    omitHostInImageRef: false,
    auth: {
      usernameLabel: "Harbor username",
      passwordLabel: "Harbor password or CLI secret",
    },
  },
  {
    id: "quay",
    label: "Quay.io",
    host: "quay.io",
    hostExample: "quay.io/celeste/api",
    authsKey: "quay.io",
    requiresRegistry: false,
    omitHostInImageRef: false,
    auth: {
      usernameLabel: "Quay username (or robot account)",
      passwordLabel: "Quay password / robot token",
    },
  },
];

const PRESETS_BY_ID = new Map(REGISTRY_PRESETS.map((p) => [p.id, p]));

export function presetById(id: RegistryPresetId): RegistryPreset | null {
  return PRESETS_BY_ID.get(id) ?? null;
}

function substituteHost(preset: RegistryPreset, registry?: string, region?: string): string {
  let host = preset.host;
  if (host.includes("{registry}")) {
    if (!registry) throw new Error(`${preset.label} requires a registry name`);
    host = host.replaceAll("{registry}", registry);
  }
  if (host.includes("{region}")) {
    if (!region) throw new Error(`${preset.label} requires a region`);
    host = host.replaceAll("{region}", region);
  }
  return host;
}

function substituteAuthsKey(preset: RegistryPreset, registry?: string, region?: string): string {
  let key = preset.authsKey;
  if (key.includes("{registry}")) {
    if (!registry) throw new Error(`${preset.label} requires a registry name`);
    key = key.replaceAll("{registry}", registry);
  }
  if (key.includes("{region}")) {
    if (!region) throw new Error(`${preset.label} requires a region`);
    key = key.replaceAll("{region}", region);
  }
  return key;
}

function cleanSegment(s: string): string {
  return s.trim().replace(/^\/+|\/+$/g, "");
}

export interface ComposeImageRefInput {
  presetId: RegistryPresetId;
  registry?: string;
  region?: string;
  namespace: string;
  image: string;
}

export function composeImageRef(input: ComposeImageRefInput): string {
  const preset = presetById(input.presetId);
  if (!preset) throw new Error(`unknown registry preset: ${input.presetId}`);
  const ns = cleanSegment(input.namespace);
  const img = cleanSegment(input.image);
  const path = `${ns}/${img}`;
  if (preset.omitHostInImageRef) return path;
  const host = substituteHost(preset, input.registry, input.region);
  return `${host}/${path}`;
}

export interface DockerConfigInput {
  presetId: RegistryPresetId;
  registry?: string;
  region?: string;
  username: string;
  password: string;
  email?: string;
}

export function buildDockerConfigJson(input: DockerConfigInput): string {
  const preset = presetById(input.presetId);
  if (!preset) throw new Error(`unknown registry preset: ${input.presetId}`);
  const key = substituteAuthsKey(preset, input.registry, input.region);
  const auth = Buffer.from(`${input.username}:${input.password}`, "utf-8").toString("base64");
  const entry: Record<string, string> = { username: input.username, password: input.password, auth };
  if (input.email) entry.email = input.email;
  return JSON.stringify({ auths: { [key]: entry } });
}

const RFC1123 = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

export interface ImagePullSecretManifest {
  apiVersion: "v1";
  kind: "Secret";
  type: "kubernetes.io/dockerconfigjson";
  metadata: { name: string; namespace: string };
  data: { ".dockerconfigjson": string };
}

export interface BuildImagePullSecretInput {
  name: string;
  namespace: string;
  preset: DockerConfigInput;
}

export function buildImagePullSecretManifest(input: BuildImagePullSecretInput): ImagePullSecretManifest {
  if (!RFC1123.test(input.name)) throw new Error(`invalid secret name '${input.name}' (RFC 1123)`);
  if (!RFC1123.test(input.namespace)) throw new Error(`invalid namespace '${input.namespace}' (RFC 1123)`);
  const json = buildDockerConfigJson(input.preset);
  const data = Buffer.from(json, "utf-8").toString("base64");
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "kubernetes.io/dockerconfigjson",
    metadata: { name: input.name, namespace: input.namespace },
    data: { ".dockerconfigjson": data },
  };
}
