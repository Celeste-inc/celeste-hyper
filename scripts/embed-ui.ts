import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

interface EmbeddedAsset {
  contentType: string;
  content: string;
  immutable: boolean;
}

const rootDir = join(import.meta.dir, "..");
const distDir = join(rootDir, "frontend", "dist");
const outFile = join(rootDir, "src", "generated", "ui-assets.ts");

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const files = await walk(distDir);
const assets: Record<string, EmbeddedAsset> = {};

for (const file of files.sort()) {
  const route = `/${relative(distDir, file).split(sep).join("/")}`;
  const bytes = await readFile(file);
  assets[route] = {
    contentType: contentTypeFor(route),
    content: bytes.toString("base64"),
    immutable: route.startsWith("/assets/"),
  };
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `export interface EmbeddedAsset {\n  contentType: string;\n  content: string;\n  immutable: boolean;\n}\n\nexport const UI_ASSETS: Record<string, EmbeddedAsset> = ${JSON.stringify(assets, null, 2)};\n`);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return Promise.resolve([path]);
  }));
  return nested.flat();
}

function contentTypeFor(path: string): string {
  const extension = Object.keys(contentTypes).find((item) => path.endsWith(item));
  if (!extension) return "application/octet-stream";
  return contentTypes[extension] ?? "application/octet-stream";
}
