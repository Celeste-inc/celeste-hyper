import { describe, expect, it } from "bun:test";
import { AlertManager } from "./manager.ts";
import type { Alert, AlertRecord, AlertStore } from "./types.ts";

class MemoryStore implements AlertStore {
  alerts = new Map<string, AlertRecord>();
  cursors = new Map<string, string>();
  getAlert(key: string) { return this.alerts.get(key) ?? null; }
  saveAlert(r: AlertRecord) { this.alerts.set(r.key, { ...r }); }
  openConditions() { return [...this.alerts.values()].filter((r) => r.open && r.condition); }
  getCursor(key: string) { return this.cursors.get(key) ?? null; }
  setCursor(key: string, value: string) { this.cursors.set(key, value); }
  pruneAlerts() { return 0; }
}

function setup(opts: { status?: number; maxPerCycle?: number } = {}) {
  const store = new MemoryStore();
  const posts: { text: string; blocks: { type: string; text?: { text: string } }[] }[] = [];
  let now = new Date("2026-10-07T20:00:00Z");
  const fetch = async (_url: string, init: { body: string }) => {
    posts.push(JSON.parse(init.body));
    const status = opts.status ?? 200;
    return { status, ok: status < 300, headers: { get: () => null }, text: async () => "" };
  };
  const manager = new AlertManager({
    webhookUrl: "https://hooks.slack.com/services/T/B/x",
    environment: "prod",
    timeZone: "America/Sao_Paulo",
    cooldownSec: 600,
    maxPerCycle: opts.maxPerCycle ?? 10,
    store,
    now: () => now,
    fetch,
    delay: async () => {},
  });
  return { store, posts, manager, advance: (sec: number) => (now = new Date(now.getTime() + sec * 1000)) };
}

const alert = (over: Partial<Alert> = {}): Alert => ({
  key: "k1",
  severity: "error",
  category: "app-error",
  service: "sollo-api",
  namespace: "sollo-prod",
  cluster: "local",
  title: "Erro registrado em sollo-api: boom",
  detail: "boom",
  occurredAt: "2026-10-07T20:00:00Z",
  ...over,
});

describe("AlertManager", () => {
  it("sends once, groups repeats inside the cooldown and reports them on the next reminder", async () => {
    const { posts, manager, advance } = setup();
    await manager.runCycle([alert()], null);
    await manager.runCycle([alert()], null);
    advance(60);
    await manager.runCycle([alert()], null);
    expect(posts).toHaveLength(1);
    advance(700);
    await manager.runCycle([alert()], null);
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[1])).toContain("2 agrupada(s)");
  });

  it("formats severity, service, tags and the detail block", async () => {
    const { posts, manager } = setup();
    await manager.runCycle([alert({ severity: "critical", tags: ["log", "error"] })], null);
    const body = JSON.stringify(posts[0]);
    expect(posts[0]!.text).toContain("CRÍTICO · sollo-api");
    expect(body).toContain("`#prod`");
    expect(body).toContain("`#sollo-api`");
    expect(body).toContain("`#app-error`");
    expect(body).toContain("```boom```");
  });

  it("resolves a condition only when its scope was scanned and it is gone", async () => {
    const { posts, manager, store } = setup();
    const cond = alert({ key: "c1", category: "pod-crashloop", condition: true, title: "Container em CrashLoopBackOff" });
    await manager.runCycle([cond], new Set(["local/sollo-prod"]));
    await manager.runCycle([], new Set(["local/other"]));
    expect(posts).toHaveLength(1);
    await manager.runCycle([], new Set(["local/sollo-prod"]));
    expect(posts).toHaveLength(2);
    expect(posts[1]!.text).toContain("RESOLVIDO");
    expect(store.getAlert("c1")!.open).toBe(false);
    await manager.runCycle([cond], new Set(["local/sollo-prod"]));
    expect(posts).toHaveLength(3);
    expect(posts[2]!.text).toContain("ERRO");
  });

  it("caps messages per cycle and summarises the rest by severity", async () => {
    const { posts, manager } = setup({ maxPerCycle: 2 });
    const many = [alert({ key: "a", severity: "error" }), alert({ key: "b", severity: "critical" }), alert({ key: "c" }), alert({ key: "d", severity: "warning" })];
    await manager.runCycle(many, null);
    expect(posts).toHaveLength(3);
    expect(posts[0]!.text).toContain("CRÍTICO");
    expect(posts[2]!.text).toBe("2 alerta(s) adicionais agrupados");
  });

  it("keeps the alert pending when Slack rejects it and retries on the next cycle", async () => {
    const failing = setup({ status: 500 });
    await failing.manager.runCycle([alert()], null);
    expect(failing.store.getAlert("k1")!.lastSent).toBeNull();
    expect(failing.posts.length).toBeGreaterThan(1);
  });
});
