import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { R2Like } from "./r2-port.ts";
import { log } from "./logger.ts";

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface R2Object {
  key: string;
  size: number;
  lastModified: Date;
}

export class R2 implements R2Like {
  private client: S3Client;
  private cfg: R2Config;

  constructor(cfg: R2Config) {
    this.cfg = cfg;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
    });
  }

  get bucket(): string {
    return this.cfg.bucket;
  }

  getConfig(): R2Config {
    return { ...this.cfg };
  }

  updateConfig(cfg: R2Config): void {
    this.cfg = cfg;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
    });
  }

  async listPrefixes(prefix: string): Promise<string[]> {
    const out = new Set<string>();
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
      }));
      for (const cp of r.CommonPrefixes ?? []) {
        if (cp.Prefix) out.add(cp.Prefix);
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return [...out];
  }

  async listObjects(prefix: string): Promise<R2Object[]> {
    const out: R2Object[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }));
      for (const o of r.Contents ?? []) {
        if (!o.Key || o.LastModified === undefined) continue;
        out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async download(key: string, dest: string): Promise<void> {
    await mkdir(dirname(dest), { recursive: true });
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!r.Body) throw new Error(`empty body for ${key}`);
    const body = r.Body as Readable;
    await pipeline(body, createWriteStream(dest));
    log.debug("r2.downloaded", { key, dest, size: r.ContentLength });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const name = (err as Error & { name?: string }).name;
      if (name === "NotFound" || name === "NoSuchKey") return false;
      throw err;
    }
  }
}
