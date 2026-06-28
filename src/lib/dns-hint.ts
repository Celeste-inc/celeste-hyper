import { lookup } from "node:dns/promises";
import { type Clock, realClock } from "./clock.ts";

export type DnsHint =
  | { resolved: true; addresses: string[]; elapsedMs: number }
  | { resolved: false; reason: string };

/** Resolves a host to addresses (node `dns.lookup {all:true}` by default). Injectable for tests. */
export type LookupFn = (host: string) => Promise<Array<{ address: string }>>;

const DEFAULT_TIMEOUT_MS = 200;
const DEFAULT_CACHE_TTL_MS = 60_000;

export interface DnsResolverOpts {
  lookupFn?: LookupFn;
  clock?: Clock;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export type DnsResolver = (host: string) => Promise<DnsHint>;

/**
 * Build a DNS-hint resolver with a hard timeout (default 200 ms) and a short in-memory cache
 * (default 60 s) so annotating `/networking` ingress endpoints can't add unbounded latency.
 */
export function makeDnsResolver(opts: DnsResolverOpts = {}): DnsResolver {
  const doLookup: LookupFn = opts.lookupFn ?? ((host) => lookup(host, { all: true }));
  const clock = opts.clock ?? realClock();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { hint: DnsHint; at: number }>();

  return async (host: string): Promise<DnsHint> => {
    if (!host) return { resolved: false, reason: "no host" };
    const now = clock.now();
    const cached = cache.get(host);
    if (cached && now - cached.at < cacheTtlMs) return cached.hint;

    const started = now;
    let timer: ReturnType<typeof clock.setTimeout> | undefined;
    const timeout = new Promise<DnsHint>((resolve) => {
      timer = clock.setTimeout(() => resolve({ resolved: false, reason: `timeout after ${timeoutMs}ms` }), timeoutMs);
    });
    const resolve = doLookup(host)
      .then((records): DnsHint => ({ resolved: true, addresses: records.map((r) => r.address), elapsedMs: clock.now() - started }))
      .catch((e): DnsHint => ({ resolved: false, reason: (e as Error).message }));

    const hint = await Promise.race([resolve, timeout]);
    if (timer !== undefined) clock.clearTimeout(timer);
    cache.set(host, { hint, at: clock.now() });
    return hint;
  };
}
