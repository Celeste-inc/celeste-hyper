const NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/; // RFC-1123 pod/container/namespace name

export function isValidK8sName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * argv for an interactive `kubectl exec` (v1 is non-tty `-i`; covers the common case without PTY
 * plumbing). pod/container are flag-injection-safe via the caller's leading-alnum `isValidK8sName`
 * (the trailing `--` is kubectl's required positional separator, not the flag-injection defense).
 */
export function buildExecArgs(namespace: string, pod: string, container: string): string[] {
  return ["-n", namespace, "exec", "-i", pod, "-c", container, "--request-timeout=0", "--", "sh"];
}

/** Minimal duplex the WS adapter provides — decoupled from Elysia so the pump is unit-testable. */
export interface ExecSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

/** Minimal subprocess surface the pump needs (matches the relevant slice of Bun.spawn / node child). */
export interface ExecProc {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  write(data: string | Uint8Array): void; // → child stdin
  kill(): void;
  readonly exited: Promise<number>;
}

/**
 * Pumps a kubectl-exec subprocess to/from a WebSocket: child stdout+stderr → socket, socket messages
 * → child stdin. Closing the socket kills the child; the child exiting closes the socket. Idempotent
 * teardown. Isolated from the Elysia `.ws` handler so it can be driven by fakes in tests.
 */
export const MAX_SESSION_MS = 30 * 60_000; // hard lifetime: a shell can't outlive this regardless
export const IDLE_MS = 10 * 60_000; // killed after this much inactivity (no client-side exec timeout)
export const MAX_SESSION_BYTES = 64 * 1024 * 1024; // kill a runaway-output shell (`yes`/`cat /dev/zero`)

export interface ExecLimits {
  maxLifetimeMs?: number;
  idleMs?: number;
  maxBytes?: number;
}

export class ExecSession {
  private closed = false;
  private bytesSent = 0;
  private readonly lifeTimer: ReturnType<typeof setTimeout>;
  private idleTimer: ReturnType<typeof setTimeout>;
  private readonly idleMs: number;
  private readonly maxBytes: number;

  constructor(
    private readonly socket: ExecSocket,
    private readonly proc: ExecProc,
    limits: ExecLimits = {},
  ) {
    this.idleMs = limits.idleMs ?? IDLE_MS;
    this.maxBytes = limits.maxBytes ?? MAX_SESSION_BYTES;
    this.lifeTimer = setTimeout(() => this.teardown(), limits.maxLifetimeMs ?? MAX_SESSION_MS);
    this.idleTimer = setTimeout(() => this.teardown(), this.idleMs);
    void this.pump(proc.stdout);
    void this.pump(proc.stderr);
    proc.exited.then(() => this.teardown()).catch(() => this.teardown());
  }

  /** Forward a client keystroke/paste to the child's stdin. */
  onMessage(data: string | Uint8Array): void {
    if (this.closed) return;
    this.touch();
    try {
      this.proc.write(data);
    } catch {
      this.teardown();
    }
  }

  /** The client disconnected. */
  onClose(): void {
    this.teardown();
  }

  /** Reset the idle deadline on any activity (stdin or stdout). */
  private touch(): void {
    if (this.closed) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.teardown(), this.idleMs);
  }

  private async pump(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;
        if (value && value.byteLength) {
          this.bytesSent += value.byteLength;
          if (this.bytesSent > this.maxBytes) break; // runaway output → teardown below
          this.touch();
          this.socket.send(value);
        }
      }
    } catch {
      // stream errored (child died / cancelled) → teardown below
    } finally {
      this.teardown();
    }
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lifeTimer);
    clearTimeout(this.idleTimer);
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}
