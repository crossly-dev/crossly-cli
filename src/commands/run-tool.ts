/**
 * Running any of the 287 tools — the engine behind both the generated command
 * tree and `crossly api`.
 *
 * The registry is imported from `@crossly/mcp/registry`, which is the same
 * array the MCP server serves. Help text, flags and validation therefore
 * cannot disagree with the tool they describe, because there is only one
 * description of it.
 */
import { ALL_TOOLS, type ToolDef } from '@crossly/mcp/registry';
import { configureClient } from '@crossly/mcp/api';
import { CliError, EXIT } from '../exit.js';
import { buildArgs, type SchemaLike } from '../args.js';
import { client } from '../client.js';
import { note, printResult, type Format } from '../render/output.js';

const BY_NAME = new Map<string, ToolDef>(ALL_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

export function allTools(): ToolDef[] {
  return ALL_TOOLS;
}

/** Wrap the API's error envelope so the exit code carries the right meaning. */
function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;

  const e = err as {
    status?: number;
    payload?: { code?: string; message?: string };
    message?: string;
    correlationId?: string;
  };
  const status = e.status;
  const code = e.payload?.code;
  const message = e.payload?.message ?? e.message ?? 'Request failed';

  // 401 and 403-for-scope get their own exit codes because the remedy differs:
  // one needs a login, the other needs a login with MORE scopes. An agent that
  // cannot tell them apart re-runs the same login forever.
  if (status === 401) return new CliError(message, EXIT.unauthenticated, code, e.correlationId);
  if (status === 403 && code === 'insufficient_scope') {
    return new CliError(message, EXIT.forbiddenScope, code, e.correlationId);
  }
  return new CliError(message, EXIT.failure, code, e.correlationId);
}

/**
 * Call a tool and return its result, without printing.
 *
 * The hand-written workflows (`logs -f`, `publish`, `ship`) are multi-call by
 * definition — they need the DATA, and a version that printed would make a
 * three-step command emit three unrelated blobs. `runTool` below is the
 * single-call path that prints; this is what everything else composes with.
 */
export async function callTool(
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<unknown> {
  configureClient(await client());
  try {
    return await tool.handler(args);
  } catch (err) {
    throw toCliError(err);
  }
}

/** Look up a tool by name, or fail with a message that names the caller's bug. */
export function requireTool(name: string): ToolDef {
  const tool = BY_NAME.get(name);
  if (!tool) {
    // A workflow naming a tool the registry lacks is a code bug, not a user
    // error — surfaced loudly rather than as a confusing API failure.
    throw new CliError(
      `Internal: this build expects a tool "${name}" that the registry does not have.`,
      EXIT.failure,
      'missing_tool',
    );
  }
  return tool;
}

export interface RunOptions {
  format: Format;
  dryRun?: boolean;
  quiet?: boolean;
}

/**
 * Validate, call, print.
 *
 * `--dry-run` stops after validation and prints what WOULD be sent. It is not
 * a server round trip: the point is to answer "did I spell this right" without
 * touching an account, and any version that called the API would defeat that.
 */
export async function runTool(
  tool: ToolDef,
  raw: Record<string, string | boolean>,
  opts: RunOptions,
): Promise<void> {
  const args = buildArgs(raw, tool.inputSchema as SchemaLike);

  if (opts.dryRun) {
    printResult({ tool: tool.name, args, sent: false }, opts.format);
    return;
  }

  // The registry's handlers call through a module-level client. Injecting ours
  // is what lets the CLI use a `crossly login` session instead of the env var
  // the MCP server expects.
  configureClient(await client());

  try {
    const result = await tool.handler(args);
    printResult(result ?? { ok: true }, opts.format);
  } catch (err) {
    const cli = toCliError(err);
    if (cli.correlationId && !opts.quiet) {
      // Printed to stderr so it never pollutes piped output, and printed at
      // all because it is the thread back to the server-side log for this
      // exact request.
      note(`correlation id: ${cli.correlationId}`);
    }
    throw cli;
  }
}
