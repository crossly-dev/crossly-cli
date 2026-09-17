#!/usr/bin/env node
/**
 * `crossly` — entry point and dispatch.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────
 *   crossly <group> <verb>   287 commands generated from the tool registry
 *   crossly api <tool>       the same tools by their exact registry name
 *   crossly login|logout|whoami
 *
 * Two ways to reach one implementation. The generated tree is for people; the
 * `api` form is for agents and scripts, whose names should stay stable even if
 * a verb is renamed for readability.
 *
 * ── ONE PLACE THAT EXITS ─────────────────────────────────────────────
 * Every failure path funnels through `main`, so there is a single decision
 * about how something is printed and which code is returned. A command that
 * called `process.exit` itself would bypass `--json` and hand a parser prose.
 */
import { parseArgs, GLOBAL_FLAGS } from './args.js';
import { CliError, EXIT } from './exit.js';
import { COMMAND_INDEX, GENERATED_COMMANDS } from './generated/commands.js';
import { commandHelp, globalHelp, groupHelp, toolList } from './help.js';
import { findTool, runTool } from './commands/run-tool.js';
import { login, logout, whoami } from './commands/auth-commands.js';
import { logs } from './commands/logs.js';
import { publish } from './commands/publish.js';
import { ship } from './commands/ship.js';
import { importCsv, exportCsv } from './commands/csv.js';
import { dev } from './commands/dev.js';
import { mcpInstall } from './commands/mcp-install.js';
import { defaultFormat, note, type Format } from './render/output.js';
import { animate, bannerAllowed, staticBanner } from './render/banner.js';

function formatFrom(raw: Record<string, string | boolean>): Format {
  if (raw.ndjson === true) return 'ndjson';
  if (raw.json === true) return 'json';
  return defaultFormat();
}

async function main(argv: string[]): Promise<number> {
  const { path, raw } = parseArgs(argv);
  const format = formatFrom(raw);
  const wantsHelp = raw.help === true || raw.h === true;

  if (path.length === 0) {
    process.stdout.write(wantsHelp || true ? globalHelp() : '');
    // No command is a usage problem, not a success — a script that typo'd the
    // subcommand away should not see 0.
    return path.length === 0 && argv.length === 0 ? EXIT.usage : EXIT.usage;
  }

  const [first, second, ...rest] = path;

  switch (first) {
    case 'help':
      process.stdout.write(second ? groupHelp(second) : globalHelp());
      return EXIT.ok;
    case 'login':
      await login(raw, format);
      return EXIT.ok;
    case 'logout':
      await logout(format);
      return EXIT.ok;
    case 'whoami':
      await whoami(format);
      return EXIT.ok;
    default:
      break;
  }

  // ── Hand-written workflows ────────────────────────────────────────
  //
  // Checked BEFORE the generated tree because several share a group with it
  // (`logs`, `listings publish`, `orders ship`). Where a name collides the
  // richer command wins — a user typing `crossly orders ship` wants the three
  // calls, not whichever single endpoint happened to derive that verb.
  const workflow = await runWorkflow(first, second, rest, raw, format, wantsHelp);
  if (workflow !== null) return workflow;

  // ── crossly api <tool> ────────────────────────────────────────────
  if (first === 'api') {
    if (raw.list === true || second === undefined) {
      process.stdout.write(toolList(format !== 'table'));
      return EXIT.ok;
    }
    const tool = findTool(second);
    if (!tool) {
      throw new CliError(
        `Unknown tool "${second}". Run \`crossly api --list\` to see all ${GENERATED_COMMANDS.length}.`,
        EXIT.usage,
        'unknown_tool',
      );
    }
    if (wantsHelp) {
      const mapped = GENERATED_COMMANDS.find((c) => c.tool === tool.name);
      process.stdout.write(commandHelp(mapped?.group ?? 'api', mapped?.verb ?? tool.name, tool.name));
      return EXIT.ok;
    }
    await runTool(tool, raw, {
      format,
      dryRun: raw['dry-run'] === true,
      quiet: raw.quiet === true || raw.q === true,
    });
    return EXIT.ok;
  }

  // ── crossly <group> <verb> ────────────────────────────────────────
  const groups = new Set(GENERATED_COMMANDS.map((c) => c.group));
  if (!groups.has(first)) {
    throw new CliError(
      `Unknown command "${first}". Run \`crossly --help\`.`,
      EXIT.usage,
      'unknown_command',
    );
  }

  if (second === undefined || wantsHelp) {
    if (second === undefined) {
      process.stdout.write(groupHelp(first));
      // A group with no verb is incomplete input. Printing help is the helpful
      // response; returning 0 would tell a script it had run something.
      return wantsHelp ? EXIT.ok : EXIT.usage;
    }
  }

  const mapped = COMMAND_INDEX.get(`${first} ${second}`);
  if (!mapped) {
    throw new CliError(
      `Unknown command "${first} ${second}". Run \`crossly ${first} --help\`.`,
      EXIT.usage,
      'unknown_command',
    );
  }

  if (wantsHelp) {
    process.stdout.write(commandHelp(mapped.group, mapped.verb, mapped.tool));
    return EXIT.ok;
  }

  const tool = findTool(mapped.tool);
  if (!tool) {
    // The generated map named a tool the registry does not have — the two are
    // built from the same source, so this means the generated file is stale.
    throw new CliError(
      `"${mapped.tool}" is mapped but missing from the registry. Run \`pnpm generate\` in packages/cli.`,
      EXIT.failure,
      'stale_command_map',
    );
  }

  // Positional leftovers are a common mistake worth naming: `crossly orders
  // get abc123` reads naturally but the schema wants `--id abc123`.
  if (rest.length > 0) {
    const req = tool.inputSchema.required ?? [];
    const hint = req.length ? ` Did you mean --${req[0]} ${rest[0]}?` : '';
    throw new CliError(
      `Unexpected argument "${rest[0]}".${hint}`,
      EXIT.usage,
      'unexpected_positional',
    );
  }

  await runTool(tool, raw, {
    format,
    dryRun: raw['dry-run'] === true,
    quiet: raw.quiet === true || raw.q === true,
  });
  return EXIT.ok;
}



/**
 * The multi-call commands.
 *
 * Returns null when nothing here handles the path, so dispatch falls through
 * to the generated tree.
 */
async function runWorkflow(
  first: string | undefined,
  second: string | undefined,
  rest: string[],
  raw: Record<string, string | boolean>,
  format: Format,
  wantsHelp: boolean,
): Promise<number | null> {
  const str = (k: string): string | undefined => {
    const v = raw[k];
    return typeof v === 'string' ? v : undefined;
  };
  const list = (k: string): string[] =>
    (str(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // `--yes` is the confirm flag for the two commands that spend money or write
  // in bulk. Spelled out rather than inferred from anything.
  const confirmed = raw.yes === true || raw.y === true;

  // --help must never reach the network.
  //
  // Handled once, here, rather than in each branch: it was per-branch and two
  // of them were missed, so `crossly inventory export --help` authenticated,
  // called the API and exited 4. Asking what a command does is not running it,
  // and a person who has not logged in yet is exactly who asks.
  const help = (text: string): number => {
    process.stdout.write(text);
    return EXIT.ok;
  };
  if (wantsHelp) {
    if (first === 'logs') return help(LOGS_HELP);
    if (first === 'listings' && second === 'publish') return help(PUBLISH_HELP);
    if (first === 'orders' && second === 'ship') return help(SHIP_HELP);
    if (first === 'dev') return help(DEV_HELP);
    if (first === 'inventory' && (second === 'import' || second === 'export')) {
      return help(CSV_HELP);
    }
    if (first === 'mcp') return help(MCP_HELP);
  }

  if (first === 'logs' && (second === undefined || second === 'tail')) {
    const filters: Record<string, unknown> = {};
    for (const k of ['platform', 'action', 'category', 'status', 'source', 'targetType', 'targetId', 'since']) {
      const v = str(k);
      if (v !== undefined) filters[k] = v;
    }
    const limit = str('limit');
    if (limit) filters.limit = Number(limit);
    await logs({ follow: raw.f === true || raw.follow === true, format, filters });
    return EXIT.ok;
  }

  if (first === 'listings' && second === 'publish') {
    const id = rest[0] ?? str('id') ?? str('inventory-item-id');
    if (!id) throw new CliError('Which item? crossly listings publish <inventoryItemId> --to a,b', EXIT.usage, 'usage');
    return publish({
      inventoryItemId: id,
      platforms: list('to'),
      format,
      noWait: raw['no-wait'] === true,
      idempotencyKey: str('idempotency-key'),
    });
  }

  if (first === 'orders' && second === 'ship') {
    const id = rest[0] ?? str('id');
    if (!id) throw new CliError('Which order? crossly orders ship <orderId>', EXIT.usage, 'usage');
    return ship({
      orderId: id,
      format,
      confirm: confirmed,
      rateId: str('rate'),
      idempotencyKey: str('idempotency-key'),
    });
  }

  if (first === 'inventory' && second === 'import') {
    const file = rest[0] ?? str('file');
    if (!file) throw new CliError('Which file? crossly inventory import <file.csv>', EXIT.usage, 'usage');
    return importCsv({ file, format, confirm: confirmed, idempotencyKey: str('idempotency-key') });
  }

  if (first === 'inventory' && second === 'export') {
    return exportCsv({ file: rest[0] ?? str('file'), format, itemIds: list('ids') });
  }

  if (first === 'dev') {
    return dev({
      forward: str('forward'),
      events: list('events'),
      quiet: raw.quiet === true || raw.q === true,
    });
  }

  if (first === 'mcp') {
    if (second === 'install') {
      return mcpInstall({ client: str('client'), format, token: str('token'), print: raw.print === true });
    }
    process.stdout.write('crossly mcp install [--client claude|cursor|claude-code] [--print]\n');
    return EXIT.usage;
  }

  return null;
}

const CSV_HELP = `crossly inventory import / export — CSV as a file

  crossly inventory import items.csv        validate only, writes nothing
  crossly inventory import items.csv --yes  write
  crossly inventory export                  CSV to stdout
  crossly inventory export items.csv        CSV to a file

The endpoint takes and returns CSV as a string, so the generated command needs
--csv "$(cat file)" — which breaks on any file big enough to matter. This reads
the file in-process instead.

FLAGS
  --yes              actually import
  --ids <a,b>        export only these item ids
  --idempotency-key  safe retries
`;

const MCP_HELP = `crossly mcp install — wire Crossly into an AI client

  crossly mcp install                    detect the client, mint a token, write it
  crossly mcp install --client cursor
  crossly mcp install --print            show the config, write nothing

Mints its own PAT rather than reusing your session: an MCP client reads its
config once and holds it for weeks, and a session token would expire.

FLAGS
  --client   claude | cursor | claude-code
  --token    use this token instead of minting one
  --print    print the config instead of writing it
`;

const LOGS_HELP = `crossly logs — what Crossly actually did

  crossly logs                 the last 50 events
  crossly logs -f              follow, live
  crossly logs -f --platform depop --status failure

FLAGS
  -f, --follow      keep streaming
  --platform        one marketplace
  --action          verb slug: list, delist, crosspost, cookie_sync
  --status          success | failure | pending
  --category        listing | connection | offer | order
  --since           ISO timestamp
  --limit           rows on the first fetch
`;

const PUBLISH_HELP = `crossly listings publish — crosspost and WAIT for the result

  crossly listings publish <inventoryItemId> --to poshmark,depop

Crossposting is async. The generated \`crossly listings crosspost\` returns as
soon as the jobs are queued; this follows them and reports per platform.
Exits 1 if any platform failed or is still pending at the deadline.

FLAGS
  --to <a,b,c>         platforms (required)
  --no-wait            queue and return
  --idempotency-key    safe retries
`;

const SHIP_HELP = `crossly orders ship — rates, label, tracking

  crossly orders ship <orderId>          show rates, buy nothing
  crossly orders ship <orderId> --yes    buy the cheapest, submit tracking

Without --yes nothing is purchased. The chosen rate is named before the money
moves.

FLAGS
  --yes              actually buy the label
  --rate <rateId>    pick one instead of the cheapest
  --idempotency-key  safe retries
`;

const DEV_HELP = `crossly dev — live webhook events, forwarded to your machine

  crossly dev                                    print events
  crossly dev --forward http://localhost:3000/hook

Outbound only: nothing here has to be reachable from the internet, so there is
no tunnel and no public URL. Reconnects with backoff; a failing local handler
is reported and does not stop the stream.

FLAGS
  --forward <url>    POST each event here (must be localhost)
  --events <a,b>     only these event names
  -q, --quiet        do not log each forward
`;

export { GLOBAL_FLAGS };

// ── Entry point ──────────────────────────────────────────────────────────
//
// Last in the file, after every declaration it reaches. `const` is in the
// temporal dead zone until its line is evaluated, so invoking main() above
// the help constants threw "Cannot access 'LOGS_HELP' before initialization"
// on --help — for four commands, only at runtime, and only on that flag.
const argv = process.argv.slice(2);

// Bare `crossly` is the welcome screen; `--help` is a question.
//
// The banner runs only on the FIRST — somebody who typed `--help` wants the
// text now, and making them watch an animation to get it is the kind of polish
// that reads as disrespect. It is also skipped when output is piped, in CI, or
// on a narrow terminal (see bannerAllowed).
if (argv.length === 0 || ((argv[0] === '--help' || argv[0] === '-h') && argv.length === 1)) {
  const welcome = argv.length === 0;
  const run = async (): Promise<never> => {
    if (welcome && bannerAllowed()) {
      await animate();
    } else if (welcome && !process.env.CROSSLY_NO_BANNER && process.stdout.isTTY) {
      // Wanted a banner but cannot animate — a still frame still sets the tone
      // and costs nothing.
      process.stdout.write(staticBanner(!process.env.NO_COLOR));
    }
    process.stdout.write(globalHelp());
    // Still a usage exit: no command was given. The banner does not change
    // that a script which ran this got nothing done.
    process.exit(welcome ? EXIT.usage : EXIT.ok);
  };
  void run();
} else {

  main(argv)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
    const cli =
      err instanceof CliError ? err : new CliError((err as Error)?.message ?? String(err));

    // Errors go to stderr ALWAYS, and as JSON when the caller asked for JSON —
    // a script that set --json should not have to parse two different shapes
    // depending on whether the call worked.
    const asJson = argv.includes('--json') || argv.includes('--ndjson');
    if (asJson) {
      process.stderr.write(
        `${JSON.stringify({
          error: {
            code: cli.errorCode ?? 'error',
            message: cli.message,
            correlationId: cli.correlationId,
          },
        })}\n`,
      );
    } else {
      note(cli.message);
    }
      process.exit(cli.code);
    });
}

