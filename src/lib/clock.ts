export type Timer = ReturnType<typeof globalThis.setTimeout> | number;

/** Injectable time source. Production uses `realClock()`; tests use `fakeClock()`. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface FakeClock extends Clock {
  /** Move time forward by `ms`, firing any timers whose deadline is reached, in order. */
  advance(ms: number): void;
  /** Number of un-fired timers. */
  readonly pending: number;
}

export function realClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
  };
}

export function fakeClock(initialMs = 0): FakeClock {
  let current = initialMs;
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();

  return {
    now: () => current,
    setTimeout(callback, ms) {
      const id = ++seq;
      timers.set(id, { at: current + ms, cb: callback });
      return id;
    },
    clearTimeout(timer) {
      timers.delete(timer as number);
    },
    advance(ms) {
      const target = current + ms;
      // Fire due timers one at a time in chronological order; a callback may schedule more.
      for (;;) {
        let nextId = -1;
        let next: { at: number; cb: () => void } | null = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (next === null || t.at < next.at)) {
            next = t;
            nextId = id;
          }
        }
        if (next === null) break;
        timers.delete(nextId);
        current = next.at;
        next.cb();
      }
      current = target;
    },
    get pending() {
      return timers.size;
    },
  };
}
