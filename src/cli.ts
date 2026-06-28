import { join } from "node:path";
import { backup, restore, migrate, ONLINE_ADVICE, type CmdResult } from "./cli/state.ts";

const USAGE = `celeste-hyper state CLI (offline — run with the process stopped)

  bun src/cli.ts state backup  --out=<path.db>     VACUUM INTO a cold-DB backup
  bun src/cli.ts state restore --from=<path.db>    validate + swap a backup in
  bun src/cli.ts state migrate                     apply pending migrations and exit
  bun src/cli.ts state backup  --online            print the hot-backup advice instead

Flags:  --db=<path>   state DB (default $HYPER_STATE_DIR/state.sqlite)
        --force       proceed even if a lock file is present (only if its pid is gone)`;

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of args) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]!] = m[2] ?? true;
  }
  return out;
}

function defaultDbPath(): string {
  return join(Bun.env.HYPER_STATE_DIR ?? "/var/lib/celeste-hyper", "state.sqlite");
}

export function run(argv: string[]): { result: CmdResult; code: number } {
  const [group, command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (group !== "state" || !command) return { result: { ok: false, message: USAGE }, code: 2 };
  const dbPath = typeof flags.db === "string" ? flags.db : defaultDbPath();
  const force = flags.force === true;

  if (command === "backup") {
    if (flags.online) return { result: { ok: true, message: ONLINE_ADVICE }, code: 0 };
    const res = backup({ dbPath, out: typeof flags.out === "string" ? flags.out : "", force });
    return { result: res, code: res.ok ? 0 : 1 };
  }
  if (command === "restore") {
    const res = restore({ dbPath, from: typeof flags.from === "string" ? flags.from : "", force });
    return { result: res, code: res.ok ? 0 : 1 };
  }
  if (command === "migrate") {
    const res = migrate({ dbPath });
    return { result: res, code: res.ok ? 0 : 1 };
  }
  return { result: { ok: false, message: `unknown command 'state ${command}'\n\n${USAGE}` }, code: 2 };
}

if (import.meta.main) {
  const { result, code } = run(Bun.argv.slice(2));
  (result.ok ? console.log : console.error)(result.message);
  process.exit(code);
}
