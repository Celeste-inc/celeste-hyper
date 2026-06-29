import { describe, it, expect } from "bun:test";
import { State } from "../lib/state.ts";
import { fakeClock } from "../lib/clock.ts";
import { buildExecArgs, isValidK8sName, ExecSession, type ExecSocket, type ExecProc } from "./exec.ts";

describe("buildExecArgs", () => {
  it("builds an interactive non-tty exec with a shell-fallback launcher", () => {
    const args = buildExecArgs("prod", "web-abc", "app");
    expect(args.slice(0, 9)).toEqual(["-n", "prod", "exec", "-i", "web-abc", "-c", "app", "--request-timeout=0", "--"]);
    expect(args.slice(9, 11)).toEqual(["/bin/sh", "-c"]);
    // The launcher tries bash → sh → ash and emits a clear error when none exist (UI-friendly).
    expect(args[11]).toContain("exec bash -i");
    expect(args[11]).toContain("exec sh -i");
    expect(args[11]).toContain("no shell");
  });
});

describe("isValidK8sName", () => {
  it("accepts RFC-1123 names and rejects flag-ish/garbage", () => {
    expect(isValidK8sName("web-abc-123")).toBe(true);
    expect(isValidK8sName("-evil")).toBe(false);
    expect(isValidK8sName("a/b")).toBe(false);
    expect(isValidK8sName("UPPER")).toBe(false);
  });
});

describe("exec token (one-shot, pod/container-bound)", () => {
  it("redeems once and returns the bound pod/container", () => {
    const clock = fakeClock(1000);
    const state = new State(":memory:", clock);
    state.createExecToken("tok", "api", "web-1", "app", 60_000);
    expect(state.redeemExecToken("tok", "api")).toEqual({ pod: "web-1", container: "app" });
    expect(state.redeemExecToken("tok", "api")).toBeNull(); // single-use
  });

  it("rejects a wrong service, an expired token, and an unknown token", () => {
    const clock = fakeClock(1000);
    const state = new State(":memory:", clock);
    state.createExecToken("tok", "api", "web-1", "app", 60_000);
    expect(state.redeemExecToken("tok", "other")).toBeNull(); // service mismatch
    expect(state.redeemExecToken("missing", "api")).toBeNull();
    state.createExecToken("tok2", "api", "p", "c", 1_000);
    clock.advance(2_000);
    expect(state.redeemExecToken("tok2", "api")).toBeNull(); // expired
  });
});

// ── ExecSession pump ───────────────────────────────────────────────
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
function fakeSocket() {
  const sent: string[] = [];
  let closed = false;
  const socket: ExecSocket = { send: (d) => sent.push(typeof d === "string" ? d : new TextDecoder().decode(d)), close: () => (closed = true) };
  return { socket, sent, isClosed: () => closed };
}
function fakeProc(stdout: ReadableStream<Uint8Array> | null, exited: Promise<number>): ExecProc & { stdinWrites: string[]; killed: () => boolean } {
  let killed = false;
  const stdinWrites: string[] = [];
  return {
    stdout,
    stderr: null,
    write: (d) => stdinWrites.push(typeof d === "string" ? d : new TextDecoder().decode(d)),
    kill: () => (killed = true),
    exited,
    stdinWrites,
    killed: () => killed,
  };
}

describe("ExecSession", () => {
  it("pumps child stdout to the socket and client messages to stdin", async () => {
    const { socket, sent } = fakeSocket();
    const proc = fakeProc(streamOf(["hello ", "world\n"]), new Promise<number>(() => {}));
    const session = new ExecSession(socket, proc);
    session.onMessage("ls -la\n");
    await new Promise((r) => setTimeout(r, 20)); // let the stdout pump drain
    expect(sent.join("")).toBe("hello world\n");
    expect(proc.stdinWrites).toEqual(["ls -la\n"]);
  });

  it("kills the child and closes the socket when the client disconnects", () => {
    const { socket, isClosed } = fakeSocket();
    const proc = fakeProc(null, new Promise<number>(() => {}));
    const session = new ExecSession(socket, proc);
    session.onClose();
    expect(proc.killed()).toBe(true);
    expect(isClosed()).toBe(true);
    session.onMessage("after close"); // no-op, doesn't write
    expect(proc.stdinWrites).toEqual([]);
  });

  it("closes the socket when the child process exits", async () => {
    const { socket, isClosed } = fakeSocket();
    const proc = fakeProc(streamOf([]), Promise.resolve(0));
    new ExecSession(socket, proc);
    await new Promise((r) => setTimeout(r, 20));
    expect(isClosed()).toBe(true);
  });

  it("tears down at the hard lifetime cap (an idle shell can't linger forever)", async () => {
    const { socket, isClosed } = fakeSocket();
    const proc = fakeProc(null, new Promise<number>(() => {})); // never exits, never sends
    new ExecSession(socket, proc, { maxLifetimeMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(proc.killed()).toBe(true);
    expect(isClosed()).toBe(true);
  });

  it("tears down after the idle timeout when there's no activity", async () => {
    const { socket, isClosed } = fakeSocket();
    const proc = fakeProc(null, new Promise<number>(() => {}));
    new ExecSession(socket, proc, { idleMs: 15, maxLifetimeMs: 10_000 });
    await new Promise((r) => setTimeout(r, 40));
    expect(proc.killed()).toBe(true);
    expect(isClosed()).toBe(true);
  });

  it("kills a runaway-output session at the byte cap", async () => {
    const { socket, isClosed } = fakeSocket();
    const proc = fakeProc(streamOf(["AAAA", "BBBB", "CCCC"]), new Promise<number>(() => {})); // 12 bytes
    new ExecSession(socket, proc, { maxBytes: 6, maxLifetimeMs: 10_000, idleMs: 10_000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(proc.killed()).toBe(true);
    expect(isClosed()).toBe(true);
  });
});
