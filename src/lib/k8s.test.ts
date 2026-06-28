import { describe, expect, it } from "bun:test";
import { imageImportCommand } from "./k8s.ts";

describe("imageImportCommand", () => {
  it("does not require sudo when running as root", () => {
    expect(imageImportCommand("k3s", "/tmp/app.tar", 0, false)).toEqual(["k3s", "ctr", "images", "import", "/tmp/app.tar"]);
    expect(imageImportCommand("containerd", "/tmp/app.tar", 0, false)).toEqual(["ctr", "-n=k8s.io", "images", "import", "/tmp/app.tar"]);
  });

  it("uses sudo for non-root k3s/containerd when sudo is available", () => {
    expect(imageImportCommand("k3s", "/tmp/app.tar", 1000, true, true)).toEqual(["sudo", "k3s", "ctr", "images", "import", "/tmp/app.tar"]);
    expect(imageImportCommand("containerd", "/tmp/app.tar", 1000, true, false)).toEqual(["sudo", "ctr", "-n=k8s.io", "images", "import", "/tmp/app.tar"]);
  });

  it("prefers k3s ctr for containerd imports when k3s is available", () => {
    expect(imageImportCommand("containerd", "/tmp/app.tar", 0, false, true)).toEqual(["k3s", "ctr", "images", "import", "/tmp/app.tar"]);
  });

  it("keeps docker load unchanged", () => {
    expect(imageImportCommand("docker", "/tmp/app.tar", 0, true)).toEqual(["docker", "load", "-i", "/tmp/app.tar"]);
  });
});
