#!/usr/bin/env node
/**
 * crossly-buyer — the Crossly Buyer API from the terminal.
 *
 * A shopper's account: cart, orders, wishlists, offers, cashback. For a
 * seller's store — listings, crossposting, fulfilment — use `crossly`
 * (@crossly/cli). They are different APIs with different credentials, which is
 * why they are different binaries rather than one with a `--buyer` flag.
 *
 * NOTHING HERE SPENDS MONEY. `cart quote` prices a basket and `offers make`
 * proposes a number; `agent act --type buy` returns a quote; no command
 * completes a purchase.
 */
import { createBuyerClient } from '@crossly/buyer-sdk';
import { configureClient } from '@crossly/buyer-mcp/api';
import { TOOL_BY_COMMAND, groups, type ToolDef } from './commands.js';
import { CliError, EXIT, exitCodeFor, type ExitCode } from './exit.js';
import { render } from './output.js';
import * as auth from './auth.js';

const BIN = 'crossly-buyer';

/** Flags the CLI consumes itself; everything else belongs to the tool schema. */
const GLOBAL_FLAGS = new Set(['json', 'ndjson', 'help', 'version', 'dry-run']);

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }

  return { positional, flags };
}

/** `--limit 25` arrives as a string; the schema says integer. Coerce by schema. */
function coerce(tool: ToolDef, flags: Record<string, string | boolean>): Record<string, unknown> {
  const props = tool.inputSchema.properties as Record<string, { type?: string }>;
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(key)) continue;

    const spec = props[key];
    if (!spec) {
      const known = Object.keys(props).sort();
      throw new CliError(
        `Unknown flag --${key}. ` +
          (known.length ? `This command accepts: ${known.map((k) => `--${k}`).join(', ')}` : 'This command takes no flags.'),
        EXIT.usage,
      );
    }

    if (spec.type === 'integer' || spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new CliError(`--${key} expects a number, got "${raw}".`, EXIT.usage);
      out[key] = n;
    } else if (spec.type === 'boolean') {
      out[key] = raw === true || raw === 'true';
    } else {
      out[key] = String(raw);
    }
  }

  const missing = (tool.inputSchema.required ?? []).filter((k) => out[k] === undefined);
  if (missing.length) {
    throw new CliError(
      `Missing required flag${missing.length > 1 ? 's' : ''}: ${missing.map((m) => `--${m}`).join(', ')}`,
      EXIT.usage,
    );
  }

  return out;
}

function topHelp(): string {
  const lines: string[] = [
    `${BIN} — your Crossly shopping, from the terminal`,
    '',
    `  ${BIN} <group> <command> [flags]`,
    '',
  ];

  for (const [group, cmds] of groups()) {
    lines.push(`  ${group}`);
    for (const c of cmds) {
      const tool = TOOL_BY_COMMAND.get(`${c.group} ${c.verb}`)!;
      // One line each: the first sentence of the tool description.
      const first = tool.description.split(/(?<=\.)\s/)[0] ?? tool.description;
      lines.push(`    ${c.verb.padEnd(13)} ${first.slice(0, 92)}`);
    }
    lines.push('');
  }

  lines.push(
    '  auth',
    '    login         Store a buyer OAuth token',
    '    logout        Forget the stored token',
    '    whoami        Show who the stored token belongs to',
    '',
    '  Global flags:  --json  --ndjson  --dry-run  --help  --version',
    '',
    `  Managing a STORE rather than shopping? That is \`crossly\` (@crossly/cli) —`,
    '  a different API with a different token.',
    '',
  );
  return lines.join('\n');
}

function commandHelp(group: string, verb: string, tool: ToolDef): string {
  const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>;
  const required = new Set(tool.inputSchema.required ?? []);

  const lines = [`${BIN} ${group} ${verb}`, '', `  ${tool.description}`, ''];
  const keys = Object.keys(props);
  if (keys.length) {
    lines.push('  Flags:');
    for (const k of keys) {
      const spec = props[k]!;
      const tag = required.has(k) ? ' (required)' : '';
      lines.push(`    --${k} <${spec.type ?? 'string'}>${tag}`);
      if (spec.description) lines.push(`        ${spec.description}`);
    }
  } else {
    lines.push('  Takes no flags.');
  }
  lines.push('');
  return lines.join('\n');
}

async function runAuth(verb: string, flags: Record<string, string | boolean>): Promise<number> {
  if (verb === 'logout') {
    process.stdout.write(auth.clear() ? 'Logged out.\n' : 'Was not logged in.\n');
    return EXIT.ok;
  }

  if (verb === 'login') {
    const token = typeof flags.token === 'string' ? flags.token : undefined;
    if (!token) {
      process.stdout.write(
        'Pass a buyer OAuth token:\n\n' +
          `    ${BIN} login --token crossly_oat_...\n\n` +
          'Buyer tokens come from the Crossly OAuth consent screen — there is no\n' +
          'buyer equivalent of a personal access token, because the scopes are\n' +
          'granted by a person agreeing to them.\n',
      );
      return EXIT.usage;
    }
    // Validate by constructing a client: wrong-kind tokens throw here with a
    // message that names the mistake, rather than being stored and failing
    // on every subsequent command.
    createBuyerClient({ token });
    auth.save({ token });
    process.stdout.write(`Saved to ${auth.AUTH_PATH}\n`);
    return EXIT.ok;
  }

  if (verb === 'whoami') {
    const { token, baseUrl } = auth.resolveToken();
    const client = createBuyerClient({ token, ...(baseUrl ? { baseUrl } : {}) });
    const profile = await client.profile.get();
    process.stdout.write(render(profile, { json: flags.json === true }) + '\n');
    return EXIT.ok;
  }

  throw new CliError(`Unknown auth command: ${verb}`, EXIT.usage);
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgv(argv);

  if (flags.version === true) {
    process.stdout.write('0.1.0\n');
    return EXIT.ok;
  }

  if (!positional.length || (flags.help === true && positional.length === 0)) {
    process.stdout.write(topHelp());
    return positional.length ? EXIT.ok : EXIT.usage;
  }

  const [first, second] = positional;

  // `login` / `logout` / `whoami` read better without an `auth` prefix.
  if (first === 'login' || first === 'logout' || first === 'whoami') {
    return runAuth(first, flags);
  }
  if (first === 'auth' && second) return runAuth(second, flags);

  if (!second) {
    const cmds = groups().get(first!);
    if (!cmds) throw new CliError(`Unknown group: ${first}. Run \`${BIN}\` to see them.`, EXIT.usage);
    process.stdout.write(
      `${BIN} ${first} <command>\n\n` + cmds.map((c) => `    ${c.verb}`).join('\n') + '\n\n',
    );
    return EXIT.usage;
  }

  const key = `${first} ${second}`;
  const tool = TOOL_BY_COMMAND.get(key);
  if (!tool) {
    throw new CliError(`Unknown command: ${key}. Run \`${BIN}\` to see them.`, EXIT.usage);
  }

  // --help must never touch the network or require a token. This is the bug
  // that shipped in the seller CLI: two branches missed the check and
  // `inventory export --help` exited 4 for anyone not logged in.
  if (flags.help === true) {
    process.stdout.write(commandHelp(first!, second!, tool));
    return EXIT.ok;
  }

  const args = coerce(tool, flags);

  if (flags['dry-run'] === true) {
    process.stdout.write(
      render({ tool: tool.name, args, wouldSend: true }, { json: flags.json === true }) + '\n',
    );
    return EXIT.ok;
  }

  const { token, baseUrl } = auth.resolveToken();
  configureClient(createBuyerClient({ token, ...(baseUrl ? { baseUrl } : {}) }));

  const result = await tool.handler(args);
  process.stdout.write(
    render(result, { json: flags.json === true, ndjson: flags.ndjson === true }) + '\n',
  );
  return EXIT.ok;
}

// Only run when executed, not when imported by a test.
if (process.argv[1] && /buyer-cli[\\/](dist|src)[\\/]index\.(js|ts)$/.test(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const code: ExitCode = exitCodeFor(err);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      const correlationId = (err as { correlationId?: string })?.correlationId;
      if (correlationId) process.stderr.write(`correlationId: ${correlationId}\n`);
      process.exit(code);
    });
}
