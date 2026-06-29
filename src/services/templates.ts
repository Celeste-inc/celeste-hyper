export type TemplateCategory = "web" | "cache" | "database" | "queue" | "proxy";

export interface TemplateEnv {
  key: string;
  description?: string;
  default?: string;
  required?: boolean;
  /** When true, the value is projected through a Kubernetes Secret instead of as a literal. */
  secret?: boolean;
}

export interface Template {
  id: string;
  label: string;
  category: TemplateCategory;
  image: string;
  defaultTag: string;
  defaultPort: number;
  portName: string;
  description: string;
  /** Source of truth for the env vars the template understands. */
  env: TemplateEnv[];
  /** Sensible defaults for autoscaling tier when the operator picks "autoscale" without overriding. */
  recommendedAutoscale?: { minReplicas: number; maxReplicas: number; targetCPUUtilizationPercentage: number };
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "nginx",
    label: "NGINX",
    category: "web",
    image: "nginx",
    defaultTag: "1.27",
    defaultPort: 80,
    portName: "http",
    description: "High-performance HTTP server and reverse proxy.",
    env: [],
    recommendedAutoscale: { minReplicas: 2, maxReplicas: 10, targetCPUUtilizationPercentage: 70 },
  },
  {
    id: "redis",
    label: "Redis",
    category: "cache",
    image: "redis",
    defaultTag: "7-alpine",
    defaultPort: 6379,
    portName: "redis",
    description: "In-memory data store. Use as cache, message broker, or session store.",
    env: [
      { key: "REDIS_PASSWORD", description: "Optional AUTH password", secret: true },
    ],
  },
  {
    id: "valkey",
    label: "Valkey",
    category: "cache",
    image: "valkey/valkey",
    defaultTag: "8-alpine",
    defaultPort: 6379,
    portName: "redis",
    description: "Open-source fork of Redis maintained by the Linux Foundation.",
    env: [],
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    category: "database",
    image: "postgres",
    defaultTag: "16",
    defaultPort: 5432,
    portName: "postgres",
    description: "Object-relational database with strong SQL compliance and extensions.",
    env: [
      { key: "POSTGRES_PASSWORD", description: "Superuser password", required: true, secret: true },
      { key: "POSTGRES_USER", description: "Superuser name", default: "postgres" },
      { key: "POSTGRES_DB", description: "Default database name", default: "postgres" },
    ],
  },
  {
    id: "mysql",
    label: "MySQL",
    category: "database",
    image: "mysql",
    defaultTag: "8.4",
    defaultPort: 3306,
    portName: "mysql",
    description: "Widely deployed open-source relational database.",
    env: [
      { key: "MYSQL_ROOT_PASSWORD", description: "Root password", required: true, secret: true },
      { key: "MYSQL_DATABASE", description: "Default database name" },
      { key: "MYSQL_USER", description: "Additional user name" },
      { key: "MYSQL_PASSWORD", description: "Additional user password", secret: true },
    ],
  },
  {
    id: "mongodb",
    label: "MongoDB",
    category: "database",
    image: "mongo",
    defaultTag: "7",
    defaultPort: 27017,
    portName: "mongo",
    description: "Document database with horizontal scaling and flexible schemas.",
    env: [
      { key: "MONGO_INITDB_ROOT_USERNAME", description: "Root user", default: "root" },
      { key: "MONGO_INITDB_ROOT_PASSWORD", description: "Root password", required: true, secret: true },
    ],
  },
  {
    id: "rabbitmq",
    label: "RabbitMQ",
    category: "queue",
    image: "rabbitmq",
    defaultTag: "3-management",
    defaultPort: 5672,
    portName: "amqp",
    description: "Message broker implementing AMQP 0-9-1, MQTT, STOMP, and more.",
    env: [
      { key: "RABBITMQ_DEFAULT_USER", description: "Default user", default: "guest" },
      { key: "RABBITMQ_DEFAULT_PASS", description: "Default password", required: true, secret: true },
    ],
  },
  {
    id: "traefik",
    label: "Traefik",
    category: "proxy",
    image: "traefik",
    defaultTag: "v3.1",
    defaultPort: 80,
    portName: "http",
    description: "Cloud-native edge router with auto-discovery and ACME support.",
    env: [],
  },
];

const TEMPLATES_BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));
const RFC1123 = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

export function templateById(id: string): Template | null {
  return TEMPLATES_BY_ID.get(id) ?? null;
}

export interface AutoscaleSpec {
  minReplicas: number;
  maxReplicas: number;
  targetCPUUtilizationPercentage: number;
}

export interface TemplateDeployInput {
  templateId: string;
  name: string;
  namespace: string;
  tag?: string;
  replicas: number;
  env?: Record<string, string>;
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  autoscale?: AutoscaleSpec;
  /** When set, added to the pod spec as `imagePullSecrets: [{ name }]` so private images can be pulled. */
  imagePullSecret?: string;
}

export interface RenderedDeployment {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    replicas: number;
    selector: { matchLabels: Record<string, string> };
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        imagePullSecrets?: Array<{ name: string }>;
        containers: Array<{
          name: string;
          image: string;
          ports: Array<{ name: string; containerPort: number; protocol: "TCP" }>;
          env?: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }>;
          resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
        }>;
      };
    };
  };
}

export interface RenderedService {
  apiVersion: "v1";
  kind: "Service";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    type: "ClusterIP" | "NodePort" | "LoadBalancer";
    selector: Record<string, string>;
    ports: Array<{ name: string; port: number; targetPort: number; protocol: "TCP" }>;
  };
}

export interface RenderedSecret {
  apiVersion: "v1";
  kind: "Secret";
  type: "Opaque";
  metadata: { name: string; namespace: string };
  data?: Record<string, string>;
}

export interface RenderedHpa {
  apiVersion: "autoscaling/v2";
  kind: "HorizontalPodAutoscaler";
  metadata: { name: string; namespace: string };
  spec: {
    scaleTargetRef: { apiVersion: string; kind: string; name: string };
    minReplicas: number;
    maxReplicas: number;
    metrics?: Array<{
      type: "Resource";
      resource?: { name: string; target: { type: "Utilization"; averageUtilization: number } };
    }>;
  };
}

export interface RenderedManifests {
  deployment: RenderedDeployment;
  service: RenderedService;
  secret?: RenderedSecret;
  hpa?: RenderedHpa;
}

function validateName(name: string): void {
  if (!RFC1123.test(name)) throw new Error(`invalid name '${name}' (RFC 1123)`);
}

function validateReplicas(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error(`replicas out of range (1..1000): ${n}`);
}

function validateAutoscale(a: AutoscaleSpec): void {
  if (a.minReplicas < 1 || a.maxReplicas < 1 || a.minReplicas > a.maxReplicas) {
    throw new Error(`autoscale min/max out of range (1 <= min <= max): ${a.minReplicas}/${a.maxReplicas}`);
  }
  if (a.targetCPUUtilizationPercentage < 1 || a.targetCPUUtilizationPercentage > 100) {
    throw new Error(`autoscale CPU target must be 1..100: ${a.targetCPUUtilizationPercentage}`);
  }
}

export interface CustomDeployInput {
  image: string;
  port: number;
  name: string;
  namespace: string;
  tag?: string;
  replicas: number;
  env?: Record<string, string>;
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  autoscale?: AutoscaleSpec;
  imagePullSecret?: string;
}

const CUSTOM_IMAGE_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*$/;

/** Deploy an arbitrary image from a Docker Hub search hit — no catalog entry required. The image
 *  reference is validated against a conservative charset (no flag-injection risk on kubectl apply). */
export function renderCustomManifests(input: CustomDeployInput): RenderedManifests {
  validateName(input.name);
  validateReplicas(input.replicas);
  if (input.autoscale) validateAutoscale(input.autoscale);
  if (!CUSTOM_IMAGE_RE.test(input.image)) throw new Error(`invalid image reference '${input.image}'`);
  if (input.port < 1 || input.port > 65535) throw new Error(`port out of range (1..65535): ${input.port}`);

  const tag = input.tag ?? "latest";
  const labels = { app: input.name, "celeste.dev/template": "custom" };
  const portName = "app";
  const containerEnv: Array<{ name: string; value?: string }> = [];
  for (const [k, v] of Object.entries(input.env ?? {})) containerEnv.push({ name: k, value: v });

  const deployment: RenderedDeployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: input.name, namespace: input.namespace, labels },
    spec: {
      replicas: input.replicas,
      selector: { matchLabels: { app: input.name } },
      template: {
        metadata: { labels },
        spec: {
          ...(input.imagePullSecret ? { imagePullSecrets: [{ name: input.imagePullSecret }] } : {}),
          containers: [
            {
              name: input.name,
              image: `${input.image}:${tag}`,
              ports: [{ name: portName, containerPort: input.port, protocol: "TCP" }],
              ...(containerEnv.length ? { env: containerEnv } : {}),
            },
          ],
        },
      },
    },
  };

  const service: RenderedService = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: input.name, namespace: input.namespace, labels },
    spec: {
      type: input.serviceType ?? "ClusterIP",
      selector: { app: input.name },
      ports: [{ name: portName, port: input.port, targetPort: input.port, protocol: "TCP" }],
    },
  };

  const manifests: RenderedManifests = { deployment, service };
  if (input.autoscale) {
    manifests.hpa = {
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      metadata: { name: input.name, namespace: input.namespace },
      spec: {
        scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: input.name },
        minReplicas: input.autoscale.minReplicas,
        maxReplicas: input.autoscale.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: { name: "cpu", target: { type: "Utilization", averageUtilization: input.autoscale.targetCPUUtilizationPercentage } },
          },
        ],
      },
    };
  }
  return manifests;
}

export function renderTemplateManifests(input: TemplateDeployInput): RenderedManifests {
  const tpl = templateById(input.templateId);
  if (!tpl) throw new Error(`unknown template '${input.templateId}'`);
  validateName(input.name);
  validateReplicas(input.replicas);
  if (input.autoscale) validateAutoscale(input.autoscale);

  // Required env vars must be present (default-applied only when no override given).
  const envValues: Record<string, string> = {};
  const secretValues: Record<string, string> = {};
  const providedEnv = input.env ?? {};
  for (const e of tpl.env) {
    const value = providedEnv[e.key] ?? e.default;
    if (value === undefined) {
      if (e.required) throw new Error(`required env '${e.key}' missing for template '${tpl.id}'`);
      continue;
    }
    if (e.secret) secretValues[e.key] = value;
    else envValues[e.key] = value;
  }

  const tag = input.tag ?? tpl.defaultTag;
  const labels = { app: input.name, "celeste.dev/template": tpl.id };
  const secretName = `${input.name}-secret`;

  const containerEnv: NonNullable<RenderedDeployment["spec"]["template"]["spec"]["containers"][number]["env"]> = [];
  for (const [k, v] of Object.entries(envValues)) containerEnv.push({ name: k, value: v });
  for (const k of Object.keys(secretValues)) {
    containerEnv.push({ name: k, valueFrom: { secretKeyRef: { name: secretName, key: k } } });
  }

  const deployment: RenderedDeployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: input.name, namespace: input.namespace, labels },
    spec: {
      replicas: input.replicas,
      selector: { matchLabels: { app: input.name } },
      template: {
        metadata: { labels },
        spec: {
          ...(input.imagePullSecret ? { imagePullSecrets: [{ name: input.imagePullSecret }] } : {}),
          containers: [
            {
              name: input.name,
              image: `${tpl.image}:${tag}`,
              ports: [{ name: tpl.portName, containerPort: tpl.defaultPort, protocol: "TCP" }],
              ...(containerEnv.length ? { env: containerEnv } : {}),
            },
          ],
        },
      },
    },
  };

  const service: RenderedService = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: input.name, namespace: input.namespace, labels },
    spec: {
      type: input.serviceType ?? "ClusterIP",
      selector: { app: input.name },
      ports: [
        {
          name: tpl.portName,
          port: tpl.defaultPort,
          targetPort: tpl.defaultPort,
          protocol: "TCP",
        },
      ],
    },
  };

  const manifests: RenderedManifests = { deployment, service };

  if (Object.keys(secretValues).length > 0) {
    manifests.secret = {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: { name: secretName, namespace: input.namespace },
      data: Object.fromEntries(
        Object.entries(secretValues).map(([k, v]) => [k, Buffer.from(v, "utf-8").toString("base64")]),
      ),
    };
  }

  if (input.autoscale) {
    manifests.hpa = {
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      metadata: { name: input.name, namespace: input.namespace },
      spec: {
        scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: input.name },
        minReplicas: input.autoscale.minReplicas,
        maxReplicas: input.autoscale.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: { type: "Utilization", averageUtilization: input.autoscale.targetCPUUtilizationPercentage },
            },
          },
        ],
      },
    };
  }

  return manifests;
}
