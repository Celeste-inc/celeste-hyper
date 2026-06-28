export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  /** Injected for tests; defaults to a real `setTimeout` delay. */
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (error: unknown) => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True for SQLite contention errors (`SQLITE_BUSY` / "database is locked"). */
export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "SQLITE_BUSY") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(message);
}

/**
 * Run `fn`, retrying retryable failures (SQLITE_BUSY by default) with exponential backoff.
 * Used by the concurrent writers landing in P0.7+ (queue claim, audit, capability writes);
 * existing single-statement writers rely on `PRAGMA busy_timeout`.
 */
export async function withRetry<T>(fn: () => T | Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 5);
  const baseMs = opts.baseMs ?? 25;
  const sleep = opts.sleep ?? defaultSleep;
  const isRetryable = opts.isRetryable ?? isSqliteBusy;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;
      await sleep(baseMs * 2 ** attempt);
    }
  }
  throw lastError;
}
