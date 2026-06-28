import { describe, it, expect } from "bun:test";
import { withRetry } from "./withRetry.ts";

function busyError(): Error {
  const e = new Error("database is locked");
  (e as { code?: string }).code = "SQLITE_BUSY";
  return e;
}

const noSleep = async () => {};

describe("withRetry", () => {
  it("retries SQLITE_BUSY then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls <= 3) throw busyError();
        return "ok";
      },
      { attempts: 5, baseMs: 1, sleep: noSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(4);
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    let thrown: unknown;
    try {
      await withRetry(
        () => {
          calls++;
          throw busyError();
        },
        { attempts: 5, baseMs: 1, sleep: noSleep },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(calls).toBe(5);
  });

  it("does not retry a non-busy error", async () => {
    let calls = 0;
    let thrown: unknown;
    try {
      await withRetry(
        () => {
          calls++;
          throw new Error("constraint violation");
        },
        { attempts: 5, baseMs: 1, sleep: noSleep },
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe("constraint violation");
    expect(calls).toBe(1);
  });

  it("backs off exponentially (base * 2^n) between retries", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls < 5) throw busyError();
        return "ok";
      },
      { attempts: 5, baseMs: 25, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe("ok");
    expect(delays).toEqual([25, 50, 100, 200]); // 4 retries before the 5th call succeeds
  });

  it("detects 'database is locked' by message even without a code", async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls === 1) throw new Error("database is locked");
        return 42;
      },
      { baseMs: 1, sleep: noSleep },
    );
    expect(result).toBe(42);
    expect(calls).toBe(2);
  });
});
