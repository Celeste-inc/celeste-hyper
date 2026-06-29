export interface ServicePortPatchInput {
  portName: string;
  port: number;
  targetPort: number | string;
  protocol: "TCP" | "UDP";
  type: "ClusterIP" | "NodePort" | "LoadBalancer";
  nodePort?: number;
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
  };
}

/**
 * Strategic-merge patch that mutates a single Service port (identified by `name`) without
 * recreating the whole array — so unrelated ports stay intact. `nodePort` is only emitted when the
 * Service type allows it; otherwise kubectl rejects the patch.
 */
export function buildServicePortPatch(input: ServicePortPatchInput): ServicePortPatch {
  const wantsNodePort = input.type === "NodePort" || input.type === "LoadBalancer";
  return {
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
