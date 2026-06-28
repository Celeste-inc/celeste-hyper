import type { R2Like } from "../lib/r2-port.ts";
import type { R2BundleService } from "./model.ts";
import { log } from "../lib/logger.ts";

export interface AvailableVersion {
  tag: string;
  imageKey: string;
  imageSize: number;
  lastModified: Date;
}

export async function listVersions(r2: R2Like, svc: R2BundleService): Promise<AvailableVersion[]> {
  const prefixes = await r2.listPrefixes(svc.r2Prefix);
  const out: AvailableVersion[] = [];

  for (const p of prefixes) {
    const tag = p.replace(svc.r2Prefix, "").replace(/\/$/, "");
    if (!tag) continue;
    const tarName = svc.imageTarPattern.replace("{name}", svc.name).replace("{tag}", tag);
    const tarKey = `${p}${tarName}`;
    const objs = await r2.listObjects(p);
    const tarObj = objs.find((o) => o.key === tarKey);
    if (!tarObj) {
      log.debug("discovery.tar_missing", { service: svc.name, prefix: p, expected: tarKey });
      continue;
    }
    out.push({ tag, imageKey: tarKey, imageSize: tarObj.size, lastModified: tarObj.lastModified });
  }

  out.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return out;
}

export function latest(versions: AvailableVersion[]): AvailableVersion | null {
  return versions[0] ?? null;
}
