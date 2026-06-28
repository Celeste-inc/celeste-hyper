import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { parseRegistryPush, verifyWebhookSignature } from "./registry-webhooks.ts";

describe("parseRegistryPush dockerhub", () => {
  it("prefixes docker.io for a bare repo name", () => {
    const body = { push_data: { tag: "v1.2.3" }, repository: { repo_name: "acme/api" } };
    expect(parseRegistryPush("dockerhub", body)).toEqual([{ imageRef: "docker.io/acme/api", tag: "v1.2.3" }]);
  });

  it("uses an already-hosted repo name as-is (dot before first slash)", () => {
    const body = { push_data: { tag: "v9" }, repository: { repo_name: "myhost.com/acme/api" } };
    expect(parseRegistryPush("dockerhub", body)).toEqual([{ imageRef: "myhost.com/acme/api", tag: "v9" }]);
  });

  it("trims whitespace in repo and tag", () => {
    const body = { push_data: { tag: "  v1  " }, repository: { repo_name: "  acme/api  " } };
    expect(parseRegistryPush("dockerhub", body)).toEqual([{ imageRef: "docker.io/acme/api", tag: "v1" }]);
  });

  it("returns [] when the tag is missing", () => {
    expect(parseRegistryPush("dockerhub", { repository: { repo_name: "acme/api" } })).toEqual([]);
  });

  it("returns [] when the repo name is missing", () => {
    expect(parseRegistryPush("dockerhub", { push_data: { tag: "v1" } })).toEqual([]);
  });
});

describe("parseRegistryPush ghcr", () => {
  it("parses the registry_package shape via container_metadata tag", () => {
    const body = {
      registry_package: {
        name: "api",
        namespace: "acme",
        registry: { url: "https://ghcr.io" },
        package_version: { version: "v1.2.3", container_metadata: { tag: { name: "v1.2.3" } } },
      },
    };
    expect(parseRegistryPush("ghcr", body)).toEqual([{ imageRef: "ghcr.io/acme/api", tag: "v1.2.3" }]);
  });

  it("parses the package shape", () => {
    const body = {
      package: { name: "api", namespace: "acme", package_version: { container_metadata: { tag: { name: "v2" } } } },
    };
    expect(parseRegistryPush("ghcr", body)).toEqual([{ imageRef: "ghcr.io/acme/api", tag: "v2" }]);
  });

  it("falls back to package_version.version when container_metadata tag is absent", () => {
    const body = { registry_package: { name: "api", namespace: "acme", package_version: { version: "v3" } } };
    expect(parseRegistryPush("ghcr", body)).toEqual([{ imageRef: "ghcr.io/acme/api", tag: "v3" }]);
  });

  it("skips a sha256 digest tag", () => {
    const body = {
      registry_package: {
        name: "api",
        namespace: "acme",
        package_version: { container_metadata: { tag: { name: "sha256:abc123" } } },
      },
    };
    expect(parseRegistryPush("ghcr", body)).toEqual([]);
  });

  it("returns [] when namespace is missing", () => {
    const body = { package: { name: "api", package_version: { container_metadata: { tag: { name: "v1" } } } } };
    expect(parseRegistryPush("ghcr", body)).toEqual([]);
  });
});

describe("parseRegistryPush acr", () => {
  it("builds imageRef from request.host + repository", () => {
    const body = {
      action: "push",
      target: { repository: "acme/api", tag: "v1.2.3" },
      request: { host: "myreg.azurecr.io" },
    };
    expect(parseRegistryPush("acr", body)).toEqual([{ imageRef: "myreg.azurecr.io/acme/api", tag: "v1.2.3" }]);
  });

  it("omits the host when request.host is absent", () => {
    const body = { action: "push", target: { repository: "acme/api", tag: "v1" } };
    expect(parseRegistryPush("acr", body)).toEqual([{ imageRef: "acme/api", tag: "v1" }]);
  });

  it("ignores non-push actions", () => {
    const body = { action: "delete", target: { repository: "acme/api", tag: "v1" } };
    expect(parseRegistryPush("acr", body)).toEqual([]);
  });

  it("skips a digest-only push (tag absent)", () => {
    const body = { action: "push", target: { repository: "acme/api", digest: "sha256:deadbeef" } };
    expect(parseRegistryPush("acr", body)).toEqual([]);
  });
});

describe("parseRegistryPush generic", () => {
  it("accepts the image field", () => {
    expect(parseRegistryPush("generic", { image: "myreg.io/acme/api", tag: "v1.2.3" })).toEqual([
      { imageRef: "myreg.io/acme/api", tag: "v1.2.3" },
    ]);
  });

  it("accepts the repository field", () => {
    expect(parseRegistryPush("generic", { repository: "myreg.io/acme/api", tag: "v2" })).toEqual([
      { imageRef: "myreg.io/acme/api", tag: "v2" },
    ]);
  });

  it("accepts an array of push objects", () => {
    const body = [
      { image: "r/a", tag: "1" },
      { image: "r/b", tag: "2" },
    ];
    expect(parseRegistryPush("generic", body)).toEqual([
      { imageRef: "r/a", tag: "1" },
      { imageRef: "r/b", tag: "2" },
    ]);
  });

  it("expands a tags array into one push per tag", () => {
    expect(parseRegistryPush("generic", { image: "r/a", tags: ["a", "b", "c"] })).toEqual([
      { imageRef: "r/a", tag: "a" },
      { imageRef: "r/a", tag: "b" },
      { imageRef: "r/a", tag: "c" },
    ]);
  });

  it("skips objects without an image or without a tag", () => {
    const body = [{ tag: "1" }, { image: "r/a" }, { image: "r/b", tag: "2" }];
    expect(parseRegistryPush("generic", body)).toEqual([{ imageRef: "r/b", tag: "2" }]);
  });
});

describe("parseRegistryPush robustness", () => {
  it("returns [] for malformed bodies across all kinds", () => {
    for (const body of [null, undefined, 42, "x", [], {}, { foo: "bar" }]) {
      expect(parseRegistryPush("dockerhub", body)).toEqual([]);
      expect(parseRegistryPush("ghcr", body)).toEqual([]);
      expect(parseRegistryPush("acr", body)).toEqual([]);
    }
  });

  it("returns [] for an unknown kind", () => {
    expect(parseRegistryPush("nope" as never, { image: "r/a", tag: "1" })).toEqual([]);
  });

  it("de-duplicates identical (imageRef, tag) pairs", () => {
    const body = [
      { image: "r/a", tag: "1" },
      { image: "r/a", tag: "1" },
      { image: "r/a", tags: ["1", "2", "2"] },
    ];
    expect(parseRegistryPush("generic", body)).toEqual([
      { imageRef: "r/a", tag: "1" },
      { imageRef: "r/a", tag: "2" },
    ]);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "topsecret";
  const body = '{"hello":"world"}';
  const digest = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a valid sha256=<hex> header", () => {
    expect(verifyWebhookSignature(secret, body, `sha256=${digest}`)).toBe(true);
  });

  it("accepts a valid bare hex header", () => {
    expect(verifyWebhookSignature(secret, body, digest)).toBe(true);
  });

  it("accepts an uppercase hex header", () => {
    expect(verifyWebhookSignature(secret, body, `sha256=${digest.toUpperCase()}`)).toBe(true);
  });

  it("rejects a null header", () => {
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(verifyWebhookSignature(secret, body, "")).toBe(false);
    expect(verifyWebhookSignature(secret, body, "sha256=")).toBe(false);
  });

  it("rejects non-hex content", () => {
    expect(verifyWebhookSignature(secret, body, "sha256=zzzz")).toBe(false);
  });

  it("rejects hex of the wrong length", () => {
    expect(verifyWebhookSignature(secret, body, "sha256=abcdef")).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhookSignature(secret, '{"hello":"mars"}', `sha256=${digest}`)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const wrong = createHmac("sha256", "other").update(body).digest("hex");
    expect(verifyWebhookSignature(secret, body, `sha256=${wrong}`)).toBe(false);
  });
});
