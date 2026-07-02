// Seed an S3/R2 bucket with a local directory tree (used by the fleet r2-bundle sim).
// Usage: bun scripts/r2-seed.ts <endpoint> <bucket> <localDir> <keyPrefix>
import { S3Client, CreateBucketCommand, PutObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [endpoint, bucket, localDir, keyPrefix = ""] = process.argv.slice(2);
if (!endpoint || !bucket || !localDir) {
  console.error("usage: bun scripts/r2-seed.ts <endpoint> <bucket> <localDir> <keyPrefix>");
  process.exit(2);
}

const client = new S3Client({
  endpoint,
  region: "auto",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "fleetadmin",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "fleetadmin123",
  },
  forcePathStyle: true,
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`created bucket ${bucket}`);
}

for (const file of walk(localDir)) {
  const rel = relative(localDir, file).split(sep).join("/");
  const key = `${keyPrefix}${rel}`;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(file) }));
  console.log(`put ${key} (${statSync(file).size} bytes)`);
}
console.log("seed done");
