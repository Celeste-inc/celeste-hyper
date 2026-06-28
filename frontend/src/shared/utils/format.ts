export function fmtTs(value?: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function fmtSize(bytes?: number): string {
  if (!bytes) return "-";
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function imageRefWithoutTag(image?: string): string {
  if (!image) return "";
  return image.split(":")[0]?.split("@")[0] ?? "";
}

export function apiError(body: { error?: string }, status: number): string {
  return `Error: ${body.error || status}`;
}
