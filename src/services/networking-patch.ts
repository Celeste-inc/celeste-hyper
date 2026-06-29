export interface ServicePortPatchInput {
  portName: string;
  port: number;
  targetPort: number | string;
  protocol: "TCP" | "UDP";
  type: "ClusterIP" | "NodePort" | "LoadBalancer";
  nodePort?: number;
  /** Optional list of host IPs the node should listen on for `port`. Empty array clears the field. */
  externalIPs?: string[];
}

export interface ServicePortPatch {
  spec: {
    type: "ClusterIP" | "NodePort" | "LoadBalancer";
    ports: Array<{
      name: string;
      port: number;
      targetPort: number | string;
      protocol: "TCP" | "UDP";
      nodePort?: number;
    }>;
    externalIPs?: string[] | null;
  };
}

/**
 * Strategic-merge patch that mutates a single Service port (identified by `name`) without
 * recreating the whole array — so unrelated ports stay intact. `nodePort` is only emitted when the
 * Service type allows it; otherwise kubectl rejects the patch.
 *
 * `externalIPs` bypasses the NodePort 30000-32767 limit by asking kube-proxy to listen on any port
 * on the named host IPs. An empty array clears the field (sent as `null` so strategic-merge wipes
 * the existing list instead of leaving it untouched).
 */
export function buildServicePortPatch(input: ServicePortPatchInput): ServicePortPatch {
  const wantsNodePort = input.type === "NodePort" || input.type === "LoadBalancer";
  const patch: ServicePortPatch = {
    spec: {
      type: input.type,
      ports: [
        {
          name: input.portName,
          port: input.port,
          targetPort: input.targetPort,
          protocol: input.protocol,
          ...(wantsNodePort && input.nodePort !== undefined ? { nodePort: input.nodePort } : {}),
        },
      ],
    },
  };
  if (input.externalIPs !== undefined) {
    patch.spec.externalIPs = input.externalIPs.length ? input.externalIPs : null;
  }
  return patch;
}

export interface DeploymentContainerPortPatchInput {
  containerName: string;
  portName: string;
  containerPort: number;
  protocol: "TCP" | "UDP";
}

export interface DeploymentContainerPortPatch {
  spec: {
    template: {
      spec: {
        containers: Array<{
          name: string;
          ports: Array<{ name: string; containerPort: number; protocol: "TCP" | "UDP" }>;
        }>;
      };
    };
  };
}

/** Strategic-merge patch that updates a single container's port without dropping other env/volumes. */
export function buildDeploymentContainerPortPatch(
  input: DeploymentContainerPortPatchInput,
): DeploymentContainerPortPatch {
  return {
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: input.containerName,
              ports: [{ name: input.portName, containerPort: input.containerPort, protocol: input.protocol }],
            },
          ],
        },
      },
    },
  };
}
