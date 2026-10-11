/**
 * `crossly mcp install` — wire Crossly into an AI client in one command.
 *
 * ── WHAT IT REPLACES ─────────────────────────────────────────────────
 * The MCP server works today and almost nobody will ever run it, because the
 * setup is: find your client's config file, know its JSON shape, mint a PAT in
 * a web app, paste it in, restart. Five steps across three applications, and
 * the error for getting any of them wrong is a tool list that is silently
 * empty.
 *
 * ── WHY IT MINTS A PAT RATHER THAN REUSING THE SESSION ───────────────
 * `crossly login` stores a token that expires and is refreshed in-process. An
 * MCP client reads its config once and holds it for weeks, so handing it that
 * token would produce an integration that works today and dies quietly on
 * Thursday. A PAT is the right credential for something that cannot refresh —
 * and it shows up in Settings as its own revocable entry, which a stolen
 * config file should.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { callTool, requireTool } from './run-tool.js';
import { CliError, EXIT } from '../exit.js';
import { apiBase } from '../client.js';
import { CLI_SCOPES } from '../scopes.js';
import { note, printResult, type Format } from '../render/output.js';

interface ClientTarget {
  id: string;
  label: string;
  /** Config path per platform. */
  path: () => string | null;
}

const TARGETS: ClientTarget[] = [
  {
    id: 'claude',
    label: 'Claude Desktop',
    path: () => {
      if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      if (process.platform === 'win32') {
        const appData = process.env.APPDATA;
        return appData ? join(appData, 'Claude', 'claude_desktop_config.json') : null;
      }
      return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    path: () => join(homedir(), '.cursor', 'mcp.json'),
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    path: () => join(homedir(), '.claude.json'),
  },
];

export interface McpInstallOptions {
  client?: string;
  format: Format;
  /** Use this token instead of minting one. */
  token?: string;
  /** Show the config without writing it. */
  print?: boolean;
}

export async function mcpInstall(opts: McpInstallOptions): Promise<number> {
  const target = opts.client
    ? TARGETS.find((t) => t.id === opts.client)
    : TARGETS.find((t) => {
        const p = t.path();
        return p !== null && existsSync(p);
      });

  if (!target) {
    throw new CliError(
      opts.client
        ? `Unknown client "${opts.client}". Known: ${TARGETS.map((t) => t.id).join(', ')}.`
        : `No supported client config found. Pass --client (${TARGETS.map((t) => t.id).join(', ')}).`,
      EXIT.usage,
      'unknown_client',
    );
  }

  const configPath = target.path();
  if (!configPath) {
    throw new CliError(`Cannot locate ${target.label}'s config on this platform.`, EXIT.failure);
  }

  const token = opts.token ?? (await mintToken());

  const entry = {
    command: 'npx',
    args: ['-y', '@crossly/mcp'],
    env: {
      CROSSLY_PAT: token,
      // Written explicitly so a staging install does not silently talk to
      // production the first time someone copies this config to another box.
      CROSSLY_API_BASE_URL: apiBase(),
    },
  };

  if (opts.print) {
    printResult({ client: target.id, path: configPath, mcpServers: { crossly: entry } }, opts.format);
    return EXIT.ok;
  }

  // Merge, never overwrite. These files hold every OTHER MCP server the person
  // has set up, and replacing the file would silently remove them.
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new CliError(
        `${configPath} is not valid JSON, so it cannot be merged safely: ${(err as Error).message}`,
        EXIT.failure,
        'config_unparseable',
      );
    }
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const replacing = servers.crossly !== undefined;
  config.mcpServers = { ...servers, crossly: entry };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  if (opts.format === 'table') {
    note(`${replacing ? 'Updated' : 'Added'} "crossly" in ${target.label}.`);
    note(configPath);
    note('');
    note(`Restart ${target.label} to pick it up.`);
  } else {
    printResult({ client: target.id, path: configPath, replaced: replacing }, opts.format);
  }
  return EXIT.ok;
}

/**
 * Mint a long-lived PAT for the MCP client.
 *
 * Named after the machine so a seller looking at Settings later can tell which
 * token belongs to which laptop — an unlabelled list of tokens is one nobody
 * dares revoke.
 */
async function mintToken(): Promise<string> {
  const { hostname } = await import('node:os');
  const created = (await callTool(requireTool('create_pat'), {
    name: `MCP — ${hostname()}`,
    // Required by the endpoint, and the same set `crossly login` asks for: an
    // MCP server that could do less than the CLI is a difference nobody would
    // predict from the outside.
    scopes: CLI_SCOPES,
  })) as { token?: string; secret?: string } | null;

  const token = created?.token ?? created?.secret;
  if (!token) {
    throw new CliError(
      'Could not mint a token for the MCP client. Create one in Settings → API and pass it with --token.',
      EXIT.failure,
      'pat_mint_failed',
    );
  }
  return token;
}
