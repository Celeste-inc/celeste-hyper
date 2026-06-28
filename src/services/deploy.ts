import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import type { Config } from "../config.ts";
import type { State } from "../lib/state.ts";
import type { ServiceModel, R2BundleService, RegistryPullService, GitSyncService, DeployMode } from "./model.ts";
import type { R2SourceStore } from "./r2-settings.ts";
import { containerNameFor, workloadNameFor } from "./model.ts";
import { Git, type GitLike, validateGitUrl, validateGitPath, validateDeployKeyPath } from "../lib/git.ts";
import { buildCanaryManifest, buildColorManifest } from "./deploy-manifest.ts";
import { runHealthGate, type HealthGateSample } from "./health-gate.ts";
import type { ClusterPod } from "../lib/k8s.ts";

const BLUE_GREEN_DRAIN_SEC = 30;
import { pathFor } from "../lib/env-files.ts";
import type { K8sPool } from "./k8s-pool.ts";
import type { K8sLike } from "../lib/k8s-port.ts";
import { type Clock, realClock } from "../lib/clock.ts";
import { log } from "../lib/logger.ts";

/**
 * Remove an object's `metadata.namespace` so `kubectl apply -n <service.namespace>` always lands in the
 * service's namespace. Without this, a bundle whose manifest hardcodes a different namespace (e.g.
 * `sollo-prod`) fails with "the namespace from the provided object does not match". Only `namespace:`
 * that is a direct child of a `metadata:` block is dropped (a `data:`/`subjects:` key named "namespace"
 * is left untouched); nested `spec.template.metadata.namespace` is harmless to drop.
 */
export function forceNamespace(manifest: string): string {
  const out: string[] = [];
  let metaIndent = -1; // indent of the active `metadata:` block, or -1 when outside one
  for (const line of manifest.split("\n")) {
    const meta = /^(\s*)metadata:\s*$/.exec(line);
    if (meta) {
      metaIndent = (meta[1] ?? "").length;
      out.push(line);
      continue;
    }
    if (metaIndent >= 0 && line.trim() !== "") {
      const indent = line.length - line.trimStart().length;
      if (indent <= metaIndent) metaIndent = -1; // dedented out of the metadata block
      else if (indent === metaIndent + 2 && /^namespace:\s/.test(line.trim())) continue; // drop it
    }
    out.push(line);
  }
  return out.join("\n");
}

export interface DeployRequest {
  service: ServiceModel;
  tag: string;
}

export interface DeployStep {
  name: string;
  ok: boolean;
  message?: string;
}

export interface DeployResult {
  deploymentId: number;
  ok: boolean;
  steps: DeployStep[];
}

export class Deployer {
  constructor(
    private readonly cfg: Config,
    private readonly r2Sources: R2SourceStore,
    private readonly pool: K8sPool,
    private readonly state: State,
    private readonly clock: Clock = realClock(),
    private readonly git: GitLike = new Git(),
  ) {}

  async deploy(req: DeployRequest): Promise<DeployResult> {
    const id = this.state.recordDeploymentStart(req.service.name, req.tag);
    return this.deployExisting(req, id);
  }

  async deployExisting(req: DeployRequest, id: number, fencingToken?: number): Promise<DeployResult> {
    try {
      if (req.service.sourceType === "r2-bundle") {
        return await this.deployR2Bundle(id, req.service, req.tag, fencingToken);
      }
      if (req.service.sourceType === "git-sync") {
        return await this.deployGitSync(id, req.service, fencingToken);
      }
      return await this.deployRegistryPull(id, req.service, req.tag, fencingToken);
    } catch (e) {
      const msg = (e as Error).message;
      this.state.updateDeployment(id, "failed", msg);
      return { deploymentId: id, ok: false, steps: [{ name: "internal", ok: false, message: msg }] };
    }
  }

  private k8sFor(service: ServiceModel) {
    return this.pool.getOrThrow(service.clusterId);
  }

  /** Commit the live tag. When a fencing token is given (P0.7 worker path), a stale token is a
   *  no-op so a zombie worker can't overwrite a newer deploy; otherwise an unfenced write. */
  private applyCurrent(name: string, tag: string, fencingToken?: number): void {
    if (fencingToken !== undefined) this.state.setCurrentFenced(name, tag, fencingToken);
    else this.state.setCurrent(name, tag);
  }

  private async deployR2Bundle(
    id: number,
    service: R2BundleService,
    tag: string,
    fencingToken?: number,
  ): Promise<DeployResult> {
    const steps: DeployStep[] = [];
    const fail = (name: string, msg: string): DeployResult => {
      steps.push({ name, ok: false, message: msg });
      this.state.updateDeployment(id, "failed", `${name}: ${msg}`);
      return { deploymentId: id, ok: false, steps };
    };
    const ok = (name: string, msg?: string): void => {
      steps.push({ name, ok: true, message: msg });
    };

    const k8s = this.k8sFor(service);
    const workDir = join(this.cfg.workDir, service.clusterId, service.name, tag);
    await mkdir(workDir, { recursive: true });
    log.info("deploy.start", { service: service.name, tag, sourceType: "r2-bundle", clusterId: service.clusterId, workDir });

    this.state.updateDeployment(id, "downloading");
    const r2 = this.r2Sources.clientFor(service.r2SourceId);
    const r2Prefix = `${service.r2Prefix}${tag}/`;
    const tarName = service.imageTarPattern.replace("{name}", service.name).replace("{tag}", tag);
    const objects = await r2.listObjects(r2Prefix);
    if (objects.length === 0) return fail("download", `no objects under ${r2Prefix}`);

    for (const o of objects) {
      const rel = o.key.replace(r2Prefix, "");
      const dest = join(workDir, rel);
      try {
        await r2.download(o.key, dest);
      } catch (e) {
        return fail("download", `${o.key}: ${(e as Error).message}`);
      }
    }
    ok("download", `${objects.length} objects → ${workDir}`);

    const tarPath = join(workDir, tarName);
    if (!existsSync(tarPath)) return fail("locate-tar", `${tarPath} not found in bundle`);

    this.state.updateDeployment(id, "loading");
    const loadR = await k8s.importImage(tarPath);
    if (loadR.code !== 0) return fail("image-import", loadR.stderr || loadR.stdout);
    ok("image-import", `runtime=${k8s.runtime}`);

    const k8sDir = join(workDir, service.manifestRoot);
    if (!existsSync(k8sDir)) return fail("manifests", `${k8sDir} not found`);

    this.state.updateDeployment(id, "applying");

    const nsFile = join(k8sDir, "namespace.yaml");
    if (existsSync(nsFile)) {
      const r = await k8s.applyFile(nsFile, service.namespace);
      if (r.code !== 0) return fail("apply-namespace", r.stderr);
      ok("apply-namespace");
    }

    const configEnv = pathFor(this.cfg.envFilesDir, service.name, "config");
    if (existsSync(configEnv)) {
      const r = await k8s.upsertConfigMapFromEnvFile(`${service.name}-config`, configEnv, service.namespace);
      if (r.code !== 0) return fail("apply-config", r.stderr);
      ok("apply-config", configEnv);
    } else {
      log.warn("deploy.no_config", { service: service.name, expected: configEnv });
    }

    const secretEnv = pathFor(this.cfg.envFilesDir, service.name, "secret");
    if (existsSync(secretEnv)) {
      const r = await k8s.upsertSecretFromEnvFile(`${service.name}-secret`, secretEnv, service.namespace);
      if (r.code !== 0) return fail("apply-secret", r.stderr);
      ok("apply-secret", secretEnv);
    } else {
      log.warn("deploy.no_secret", { service: service.name, expected: secretEnv });
    }

    const renderedDeployment = join(k8sDir, "deployment.rendered.yaml");
    const deploymentFile = existsSync(renderedDeployment)
      ? renderedDeployment
      : join(k8sDir, "deployment.yaml");

    if (!existsSync(deploymentFile)) return fail("apply-deployment", `deployment.yaml not found in ${k8sDir}`);
    {
      // env-hash so a config/secret change forces a rolling restart on redeploy — `envFrom` does NOT
      // hot-reload, so without this an edited config.env/secret.env never reaches the running pod.
      // A manifest carrying the `__ENV_HASH__` placeholder (in a pod-template annotation) gets a new
      // template on any env change → rollout. Manifests without the placeholder are unaffected (no-op).
      const envParts: string[] = [];
      if (existsSync(configEnv)) envParts.push(await readFile(configEnv, "utf8"));
      if (existsSync(secretEnv)) envParts.push(await readFile(secretEnv, "utf8"));
      const envHash = createHash("sha256").update(envParts.join(" ")).digest("hex").slice(0, 16);
      let yaml = (await readFile(deploymentFile)).toString();
      yaml = forceNamespace(yaml.replaceAll("__IMAGE_TAG__", tag).replaceAll("__ENV_HASH__", envHash));
      const r = await k8s.applyManifest(yaml, service.namespace);
      if (r.code !== 0) return fail("apply-deployment", r.stderr);
      ok("apply-deployment", deploymentFile);
    }

    const skip = new Set([
      "namespace.yaml",
      "configmap.example.yaml", "configmap.yaml",
      "secret.example.yaml", "secret.yaml",
      "deployment.yaml", "deployment.rendered.yaml",
    ]);
    for (const f of (await readdir(k8sDir)).filter((f) => f.endsWith(".yaml") && !skip.has(f))) {
      const manifest = forceNamespace((await readFile(join(k8sDir, f))).toString());
      const r = await k8s.applyManifest(manifest, service.namespace);
      if (r.code !== 0) return fail(`apply-${f}`, r.stderr);
      ok(`apply-${f}`);
    }

    this.applyCurrent(service.name, tag, fencingToken);
    this.state.updateDeployment(id, "done");
    log.info("deploy.done", { service: service.name, tag });
    return { deploymentId: id, ok: true, steps };
  }

  /**
   * git-sync (P2.3): shallow-clone `gitRef` (deploy key via GIT_SSH_COMMAND, never argv), resolve the
   * HEAD sha, then run the same env-merge + `kubectl apply` pipeline as r2-bundle over `gitPath`. The
   * resolved sha becomes the current tag. URL/path/key are re-validated here (defense in depth).
   */
  private async deployGitSync(id: number, service: GitSyncService, fencingToken?: number): Promise<DeployResult> {
    const steps: DeployStep[] = [];
    const fail = (name: string, msg: string): DeployResult => {
      steps.push({ name, ok: false, message: msg });
      this.state.updateDeployment(id, "failed", `${name}: ${msg}`);
      return { deploymentId: id, ok: false, steps };
    };
    const ok = (name: string, msg?: string): void => void steps.push({ name, ok: true, message: msg });

    const urlV = validateGitUrl(service.gitUrl, this.cfg.git.hostAllowlist);
    if (!urlV.ok) return fail("validate", urlV.error);
    const pathV = validateGitPath(service.gitPath);
    if (!pathV.ok) return fail("validate", pathV.error);
    if (service.deployKeyPath) {
      const keyV = validateDeployKeyPath(service.deployKeyPath, this.cfg.git.keysDir);
      if (!keyV.ok) return fail("validate", keyV.error);
    }

    const k8s = this.k8sFor(service);
    // One clone dir per service, wiped first — bounds disk (no per-deploy accumulation).
    const dest = join(this.cfg.workDir, service.clusterId, service.name, "git");
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    log.info("deploy.start", { service: service.name, ref: service.gitRef, sourceType: "git-sync", clusterId: service.clusterId, dest });

    this.state.updateDeployment(id, "downloading");
    const sshKey = service.deployKeyPath;
    // `core.symlinks=false`: a malicious repo can't ship a symlink (e.g. gitPath → `/`) that the later
    // `kubectl apply -f <gitPath>` would follow out of the clone — git writes the link target as a
    // plain file instead. `--single-branch --no-tags` keeps the shallow clone minimal. url/dest are
    // after `--` so they can't be read as flags.
    const clone = await this.git.run(
      ["-c", "core.symlinks=false", "clone", "--depth=1", "--single-branch", "--no-tags", "--branch", service.gitRef, "--", service.gitUrl, dest],
      { sshKey },
    );
    if (clone.code !== 0) return fail("git-clone", clone.stderr || clone.stdout);
    const rev = await this.git.run(["-C", dest, "rev-parse", "HEAD"]);
    const sha = rev.code === 0 ? rev.stdout.trim() : service.gitRef;
    ok("git-clone", `${service.gitRef} @ ${sha.slice(0, 12)}`);

    const k8sDir = pathV.path === "." ? dest : join(dest, pathV.path);
    if (!existsSync(k8sDir)) return fail("manifests", `gitPath '${service.gitPath}' not found in repo`);
    // Defense in depth beyond core.symlinks=false: the resolved manifest dir must stay inside the
    // clone (a symlinked component must not make `kubectl apply` read host files).
    try {
      const realRoot = realpathSync(dest);
      const realDir = realpathSync(k8sDir);
      if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) return fail("manifests", "gitPath escapes the clone root");
    } catch {
      return fail("manifests", "could not resolve gitPath");
    }

    this.state.updateDeployment(id, "applying");
    const configEnv = pathFor(this.cfg.envFilesDir, service.name, "config");
    if (existsSync(configEnv)) {
      const r = await k8s.upsertConfigMapFromEnvFile(`${service.name}-config`, configEnv, service.namespace);
      if (r.code !== 0) return fail("apply-config", r.stderr);
      ok("apply-config", configEnv);
    }
    const secretEnv = pathFor(this.cfg.envFilesDir, service.name, "secret");
    if (existsSync(secretEnv)) {
      const r = await k8s.upsertSecretFromEnvFile(`${service.name}-secret`, secretEnv, service.namespace);
      if (r.code !== 0) return fail("apply-secret", r.stderr);
      ok("apply-secret", secretEnv);
    }

    const apply = await k8s.applyFile(k8sDir, service.namespace);
    if (apply.code !== 0) return fail("apply-manifests", apply.stderr);
    ok("apply-manifests", k8sDir);

    this.applyCurrent(service.name, sha, fencingToken);
    this.state.updateDeployment(id, "done", `git-sync ${service.gitRef} @ ${sha.slice(0, 12)}`);
    log.info("deploy.done", { service: service.name, ref: service.gitRef, sha });
    return { deploymentId: id, ok: true, steps };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(() => resolve(), ms);
    });
  }

  /** Build the health-gate sampler: reads workload status + per-pod restart/waiting state. */
  private healthSample(k8s: K8sLike, service: RegistryPullService, workload: string): () => Promise<HealthGateSample> {
    return async () => {
      const wl = await k8s.getWorkloadJson(service.workloadKind, workload, service.namespace);
      // Surface a read failure as a thrown error (the gate records it in lastReason) rather than
      // defaulting to 0 replicas, which is indistinguishable from a real scale-to-zero.
      if (wl.code !== 0) throw new Error(`workload read failed: ${(wl.stderr || wl.stdout).trim().slice(0, 120)}`);
      let j: { status?: { readyReplicas?: number; replicas?: number; observedGeneration?: number }; spec?: { replicas?: number }; metadata?: { generation?: number } } = {};
      try {
        j = JSON.parse(wl.stdout);
      } catch (e) {
        throw new Error(`workload read returned non-JSON: ${(e as Error).message}`);
      }
      const selector = (await k8s.getWorkloadSelector(service.workloadKind, workload, service.namespace)) ?? `app=${service.name}`;
      let pods: ClusterPod[] = [];
      try {
        pods = await k8s.listPods(service.namespace, selector);
      } catch {
        // unreachable pods → treated as not-ready by the gate
      }
      return {
        readyReplicas: j.status?.readyReplicas ?? 0,
        replicas: j.spec?.replicas ?? j.status?.replicas ?? 0,
        observedGeneration: j.status?.observedGeneration ?? 0,
        generation: j.metadata?.generation ?? 0,
        pods: pods.map((p) => ({
          phase: p.phase,
          maxRestarts: p.containers.reduce((m, c) => Math.max(m, c.restartCount), 0),
          waitingReason: p.containers.find((c) => c.waitingReason)?.waitingReason,
          terminatedReason: p.containers.find((c) => c.terminatedReason)?.terminatedReason,
        })),
      };
    };
  }

  private async deployRegistryPull(
    id: number,
    service: RegistryPullService,
    tag: string,
    fencingToken?: number,
  ): Promise<DeployResult> {
    const steps: DeployStep[] = [];
    const fail = (name: string, msg: string): DeployResult => {
      steps.push({ name, ok: false, message: msg });
      this.state.updateDeployment(id, "failed", `${name}: ${msg}`);
      return { deploymentId: id, ok: false, steps };
    };
    const ok = (name: string, msg?: string): void => {
      steps.push({ name, ok: true, message: msg });
    };

    const mode: DeployMode = service.deployMode ?? "rolling";
    const k8s = this.k8sFor(service);
    log.info("deploy.start", { service: service.name, tag, sourceType: "registry-pull", mode, clusterId: service.clusterId });
    this.state.updateDeployment(id, "applying", `mode: ${mode}`);

    const fullImage = `${service.imageRef}:${tag}`;
    const workload = workloadNameFor(service);
    const container = containerNameFor(service);

    // canary/blue-green only make sense for a Deployment (the route also enforces this).
    if ((mode === "canary" || mode === "blue-green") && service.workloadKind !== "Deployment") {
      return fail("mode", `${mode} requires a Deployment workload (got ${service.workloadKind})`);
    }

    if (mode === "blue-green") {
      return this.deployBlueGreen(id, service, tag, fullImage, container, k8s, fencingToken, steps, ok, fail);
    }

    if (mode === "recreate") {
      const p = await k8s.patchWorkloadStrategy(service.workloadKind, workload, service.namespace, "Recreate");
      if (p.code !== 0) return fail("recreate-strategy", p.stderr || p.stdout);
      ok("recreate-strategy", "spec.strategy.type=Recreate");
    } else if (mode === "canary") {
      const gate = await this.runCanaryGate(service, fullImage, container, workload, k8s, ok, fail);
      if (gate) return gate; // canary gate failed (already torn down)
    }

    // Common rollout — used by rolling, recreate, and the canary promotion to the main workload.
    const r = await k8s.setImage(service.workloadKind, workload, container, fullImage, service.namespace);
    if (r.code !== 0) return fail("set-image", r.stderr || r.stdout);
    ok("set-image", fullImage);
    const rs = await k8s.rolloutStatus(service.workloadKind, workload, service.namespace, 180);
    if (rs.code !== 0) return fail("rollout", rs.stderr || rs.stdout);
    ok("rollout", `${service.workloadKind}/${workload} ready`);

    // Steady-state health gate (P1.8): rollout-status returns when pods come up, but not always
    // after they've served stably. The gate only promotes `current_deployment` once health holds.
    if (service.healthGate) {
      const result = await runHealthGate(this.healthSample(k8s, service, workload), service.healthGate, this.clock);
      this.state.setHealthGateResult(id, JSON.stringify(result));
      if (!result.ok) return fail("health-gate", result.lastReason);
      ok("health-gate", `${result.attempts} attempts — ${result.lastReason}`);
    }

    this.applyCurrent(service.name, tag, fencingToken);
    this.state.updateDeployment(id, "done", `mode: ${mode}`);
    log.info("deploy.done", { service: service.name, tag, mode });
    return { deploymentId: id, ok: true, steps };
  }

  /** Canary: stand up a sibling Deployment on the new image, soak-observe its readiness, then tear
   *  it down. Returns a (failed) DeployResult to abort, or null when the gate passes (promote). */
  private async runCanaryGate(
    service: RegistryPullService,
    fullImage: string,
    container: string,
    workload: string,
    k8s: K8sLike,
    ok: (name: string, msg?: string) => void,
    fail: (name: string, msg: string) => DeployResult,
  ): Promise<DeployResult | null> {
    const cfg = service.canaryConfig ?? { replicas: 1, observationSec: 60, successThreshold: 3 };
    const canaryName = `${workload}-canary`;
    const got = await k8s.getWorkloadJson("Deployment", workload, service.namespace);
    if (got.code !== 0) return fail("canary-read", got.stderr || got.stdout);
    let manifest: unknown;
    try {
      manifest = JSON.parse(got.stdout);
    } catch (e) {
      return fail("canary-read", `non-JSON workload: ${(e as Error).message}`);
    }
    const canary = buildCanaryManifest(manifest as never, canaryName, container, fullImage, cfg.replicas);
    const applied = await k8s.applyManifest(JSON.stringify(canary), service.namespace);
    if (applied.code !== 0) return fail("canary-create", applied.stderr || applied.stdout);
    ok("canary-create", canaryName);
    try {
      const interval = Math.max(1, Math.ceil(cfg.observationSec / cfg.successThreshold)) * 1000; // ceil → over-observe, never short-change the gate
      for (let tick = 0; tick < cfg.successThreshold; tick++) {
        await this.delay(interval);
        const ready = await k8s.getReadyReplicas("Deployment", canaryName, service.namespace);
        if (ready < cfg.replicas) return fail("canary-observe", `canary not ready (${ready}/${cfg.replicas}) at tick ${tick + 1}`);
      }
      ok("canary-observe", `healthy for ${cfg.successThreshold} ticks`);
      return null;
    } finally {
      await k8s.deleteWorkload("Deployment", canaryName, service.namespace).catch(() => {});
    }
  }

  /** Blue-green: stand up a `<workload>-green` Deployment with a fresh label set, wait for it, flip
   *  the Service selector to it, then drain the old workload to zero. */
  private async deployBlueGreen(
    id: number,
    service: RegistryPullService,
    tag: string,
    fullImage: string,
    container: string,
    k8s: K8sLike,
    fencingToken: number | undefined,
    steps: DeployStep[],
    ok: (name: string, msg?: string) => void,
    fail: (name: string, msg: string) => DeployResult,
  ): Promise<DeployResult> {
    const workload = workloadNameFor(service);
    const greenName = `${workload}-green`;
    const svcInfo = await k8s.getServiceInfo(workload, service.namespace);
    if (!svcInfo) return fail("bluegreen", "no Service found to flip; blue-green needs a Service");
    const got = await k8s.getWorkloadJson("Deployment", workload, service.namespace);
    if (got.code !== 0) return fail("bluegreen-read", got.stderr || got.stdout);
    let manifest: unknown;
    try {
      manifest = JSON.parse(got.stdout);
    } catch (e) {
      return fail("bluegreen-read", `non-JSON workload: ${(e as Error).message}`);
    }
    const { manifest: green, labels } = buildColorManifest(manifest as never, greenName, service.name, container, fullImage, "green");
    const applied = await k8s.applyManifest(JSON.stringify(green), service.namespace);
    if (applied.code !== 0) return fail("bluegreen-create", applied.stderr || applied.stdout);
    ok("bluegreen-create", greenName);
    const rs = await k8s.rolloutStatus("Deployment", greenName, service.namespace, 180);
    if (rs.code !== 0) {
      await k8s.deleteWorkload("Deployment", greenName, service.namespace).catch(() => {});
      return fail("bluegreen-rollout", rs.stderr || rs.stdout);
    }
    ok("bluegreen-rollout", `${greenName} ready`);
    // Gate the green deployment's steady-state health BEFORE flipping traffic to it.
    if (service.healthGate) {
      const result = await runHealthGate(this.healthSample(k8s, service, greenName), service.healthGate, this.clock);
      this.state.setHealthGateResult(id, JSON.stringify(result));
      if (!result.ok) {
        await k8s.deleteWorkload("Deployment", greenName, service.namespace).catch(() => {});
        return fail("bluegreen-health-gate", result.lastReason);
      }
      ok("bluegreen-health-gate", result.lastReason);
    }
    const flip = await k8s.patchServiceSelector(svcInfo.name, service.namespace, labels);
    if (flip.code !== 0) {
      await k8s.deleteWorkload("Deployment", greenName, service.namespace).catch(() => {});
      return fail("bluegreen-flip", flip.stderr || flip.stdout);
    }
    ok("bluegreen-flip", `Service ${svcInfo.name} → green`);
    await this.delay(BLUE_GREEN_DRAIN_SEC * 1000);
    const drain = await k8s
      .scaleWorkload("Deployment", workload, service.namespace, 0)
      .catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
    ok("bluegreen-drain", drain.code === 0 ? `scaled ${workload} (blue) to 0` : `drain failed (${drain.stderr}); blue may still be running`);

    this.applyCurrent(service.name, tag, fencingToken);
    this.state.updateDeployment(id, "done", "mode: blue-green");
    log.info("deploy.done", { service: service.name, tag, mode: "blue-green" });
    return { deploymentId: id, ok: true, steps };
  }
}
