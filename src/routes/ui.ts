import { Elysia } from "elysia";
import { Buffer } from "node:buffer";
import { UI_ASSETS, type EmbeddedAsset } from "../generated/ui-assets.ts";

const INDEX_PATH = "/index.html";
const ASSET_CACHE = "public, max-age=31536000, immutable";
const HTML_CACHE = "no-cache";

function normalizePath(path: string): string {
  if (path === "/" || path === "") return INDEX_PATH;
  if (UI_ASSETS[path]) return path;
  if (path.startsWith("/assets/")) return path;
  return INDEX_PATH;
}

function assetResponse(asset: EmbeddedAsset): Response {
  return new Response(Buffer.from(asset.content, "base64"), {
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": asset.immutable ? ASSET_CACHE : HTML_CACHE,
    },
  });
}

function serve(raw: string): Response {
  // An /api/* path reaching the static handler means no API route matched.
  if (raw === "/api" || raw.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json;charset=utf-8" },
    });
  }
  const path = normalizePath(raw);
  const asset = UI_ASSETS[path];
  if (!asset && path.startsWith("/assets/")) return new Response("Not Found", { status: 404 });
  const resolved = asset ?? UI_ASSETS[INDEX_PATH];
  if (!resolved) return new Response("UI assets are not embedded", { status: 500 });
  return assetResponse(resolved);
}

/**
 * Serve the embedded Vite assets with SPA fallback: `/assets/*` misses 404, `/api/*` misses
 * 404 as JSON, everything else falls back to index.html.
 */
export const staticAssets = () =>
  new Elysia()
    .get("/", ({ request }) => serve(new URL(request.url).pathname))
    .get("/*", ({ request }) => serve(new URL(request.url).pathname));
