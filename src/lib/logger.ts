const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const envLevel = (Bun.env.LOG_LEVEL ?? "info") as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

export type LogFormat = "json" | "pretty";
const FORMATS: Record<string, LogFormat> = { json: "json", pretty: "pretty" };

/** CLI flag (`--log-format=pretty` / `--log-format pretty`) wins over `LOG_FORMAT`; default json. */
export function resolveLogFormat(argv: string[], env: Record<string, string | undefined>): LogFormat {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--log-format=")) return FORMATS[a.slice("--log-format=".length)] ?? "json";
    if (a === "--log-format") return FORMATS[argv[i + 1] ?? ""] ?? "json";
  }
  return FORMATS[env.LOG_FORMAT ?? ""] ?? "json";
}

type Record_ = { ts: string; level: Level; event: string; [k: string]: unknown };

function prettyValue(v: unknown): string {
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

// Quote any event name / field key carrying a newline so one record always renders as one line
// (the JSON path escapes these for free; pretty must match to stay greppable / shipper-safe).
const safeToken = (s: string): string => (/[\r\n]/.test(s) ? JSON.stringify(s) : s);

/** Render one record either as a JSON line (machine-parseable, the default) or a human-readable line. */
export function formatLine(format: LogFormat, record: Record_): string {
  if (format === "json") return JSON.stringify(record);
  const { ts, level, event, ...fields } = record;
  const time = ts.slice(11, 23); // HH:MM:SS.mmm from the ISO timestamp
  const head = `${time} ${level.toUpperCase().padEnd(5)} ${safeToken(event)}`;
  const tail = Object.entries(fields).map(([k, v]) => `${safeToken(k)}=${prettyValue(v)}`);
  return tail.length ? `${head} ${tail.join(" ")}` : head;
}

const format = resolveLogFormat(Bun.argv, Bun.env);

function emit(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < threshold) return;
  const line = formatLine(format, { ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
