import type { R2Config, R2Object } from "./r2.ts";

/**
 * The public surface of `R2`, mirrored as an interface so consumers depend on the seam,
 * not the concrete S3 client. `R2 implements R2Like`; tests pass fakes.
 */
export interface R2Like {
  readonly bucket: string;
  getConfig(): R2Config;
  updateConfig(cfg: R2Config): void;
  listPrefixes(prefix: string): Promise<string[]>;
  listObjects(prefix: string): Promise<R2Object[]>;
  download(key: string, dest: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
