import { describe, it, expect } from "bun:test";
import {
  REGISTRY_PRESETS,
  presetById,
  composeImageRef,
  buildDockerConfigJson,
  buildImagePullSecretManifest,
} from "./registry-presets.ts";

describe("registry presets catalog", () => {
  it("exposes the well-known providers operators recognise", () => {
    const ids = REGISTRY_PRESETS.map((p) => p.id).sort();
    expect(ids).toEqual(["acr", "docker-hub", "ecr", "ghcr", "harbor", "quay"]);
  });

  it("each preset declares a server, default registry hostname, and auth shape", () => {
    for (const p of REGISTRY_PRESETS) {
      expect(p.label).toBeTruthy();
      expect(typeof p.host).toBe("string");
      expect(p.auth.usernameLabel).toBeTruthy();
      expect(p.auth.passwordLabel).toBeTruthy();
    }
  });

  it("ghcr default host is ghcr.io and references a username + PAT", () => {
    const ghcr = presetById("ghcr")!;
    expect(ghcr.host).toBe("ghcr.io");
    expect(ghcr.auth.usernameLabel.toLowerCase()).toContain("github");
    expect(ghcr.auth.passwordLabel.toLowerCase()).toContain("token");
  });

  it("ACR host is parameterised by registry name (<name>.azurecr.io)", () => {
    const acr = presetById("acr")!;
    expect(acr.host).toContain("{registry}");
    expect(acr.hostExample).toMatch(/azurecr\.io$/);
  });
});

describe("composeImageRef", () => {
  it("ghcr: combines org + image into ghcr.io/<org>/<image>", () => {
    const ref = composeImageRef({ presetId: "ghcr", namespace: "acme", image: "api" });
    expect(ref).toBe("ghcr.io/acme/api");
  });

  it("acr: substitutes the registry name into the host", () => {
    const ref = composeImageRef({ presetId: "acr", registry: "celeste", namespace: "prod", image: "api" });
    expect(ref).toBe("celeste.azurecr.io/prod/api");
  });

  it("docker-hub: omits the host entirely (the runtime injects it)", () => {
    const ref = composeImageRef({ presetId: "docker-hub", namespace: "library", image: "nginx" });
    expect(ref).toBe("library/nginx");
  });

  it("strips trailing slashes / spaces so the assembled ref is clean", () => {
    const ref = composeImageRef({ presetId: "ghcr", namespace: "  acme/ ", image: " /api  " });
    expect(ref).toBe("ghcr.io/acme/api");
  });

  it("throws when the preset is unknown", () => {
    expect(() => composeImageRef({ presetId: "unknown" as never, namespace: "x", image: "y" })).toThrow();
  });

  it("throws when ACR is requested without a registry name", () => {
    expect(() => composeImageRef({ presetId: "acr", namespace: "p", image: "i" })).toThrow(/registry/i);
  });
});

describe("buildDockerConfigJson", () => {
  it("emits a docker-config JSON with base64(<user>:<pass>) under the right host key", () => {
    const json = buildDockerConfigJson({
      presetId: "ghcr",
      username: "octocat",
      password: "ghp_xyz",
      email: "octo@example.com",
    });
    const parsed = JSON.parse(json) as { auths: Record<string, { auth: string; username: string; email?: string }> };
    expect(Object.keys(parsed.auths)).toEqual(["ghcr.io"]);
    const entry = parsed.auths["ghcr.io"]!;
    expect(entry.username).toBe("octocat");
    expect(entry.email).toBe("octo@example.com");
    expect(Buffer.from(entry.auth, "base64").toString("utf-8")).toBe("octocat:ghp_xyz");
  });

  it("uses the parameterised ACR host for the auths key", () => {
    const json = buildDockerConfigJson({
      presetId: "acr",
      registry: "celeste",
      username: "AzureCLI",
      password: "...",
    });
    const parsed = JSON.parse(json) as { auths: Record<string, unknown> };
    expect(Object.keys(parsed.auths)).toEqual(["celeste.azurecr.io"]);
  });

  it("docker-hub uses the canonical https://index.docker.io/v1/ key", () => {
    const json = buildDockerConfigJson({
      presetId: "docker-hub",
      username: "u",
      password: "p",
    });
    const parsed = JSON.parse(json) as { auths: Record<string, unknown> };
    expect(Object.keys(parsed.auths)).toEqual(["https://index.docker.io/v1/"]);
  });
});

describe("buildImagePullSecretManifest", () => {
  it("renders a Kubernetes Secret of type kubernetes.io/dockerconfigjson", () => {
    const manifest = buildImagePullSecretManifest({
      name: "ghcr-pull",
      namespace: "default",
      preset: { presetId: "ghcr", username: "octocat", password: "ghp_xyz" },
    });
    expect(manifest.apiVersion).toBe("v1");
    expect(manifest.kind).toBe("Secret");
    expect(manifest.type).toBe("kubernetes.io/dockerconfigjson");
    expect(manifest.metadata).toEqual({ name: "ghcr-pull", namespace: "default" });
    const decoded = Buffer.from(manifest.data![".dockerconfigjson"]!, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as { auths: Record<string, unknown> };
    expect(Object.keys(parsed.auths)).toEqual(["ghcr.io"]);
  });

  it("uses RFC-1123 validation on the secret name (rejects invalid names)", () => {
    expect(() =>
      buildImagePullSecretManifest({
        name: "Invalid Name!",
        namespace: "default",
        preset: { presetId: "ghcr", username: "x", password: "y" },
      }),
    ).toThrow(/name/i);
  });
});
