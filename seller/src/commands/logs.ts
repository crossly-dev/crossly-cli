/**
 * `crossly logs` — what Crossly actually did, live.
 *
 * ── WHY THIS IS THE FLAGSHIP COMMAND ─────────────────────────────────
 * Every platform call already records an `action_events` row: what was sent,
 * what came back, how long it took, and why it failed. That record is the best
 * debugging surface this product has and until now it has only been reachable
 * through a dashboard. `-f` is what turns it into the thing you leave open in
 * a second terminal while you publish a listing.
 *
 * ── THE CURSOR IS ON TIME, AND TIME IS NOT UNIQUE ────────────────────
 * The API filters with `since` (inclusive), so paging on timestamp alone
 * re-delivers every row that shares the newest millisecond — a burst of
 * crossposts genuinely does. Ids of everything already printed are therefore
 * remembered and skipped, and the set is trimmed to the newest batch rather
 * than grown forever: a tail left running overnight must not turn into a
 * memory leak.
 */
import { requireTool, callTool } from './run-tool.js';
import { rowsOf, note, type Format } from '../render/output.js';
import { CliError, EXIT } from '../exit.js';

interface LogRow {
  id?: string;
  createdAt?: string;
  platform?: string | null;
  action?: string | null;
  category?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  errorMessage?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  correlationId?: string | null;
}

const COLOUR = {
  reset: '[0m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
};

/** Colour only for a terminal. Piped output must stay parseable. */
function paint(text: string, colour: keyof typeof COLOUR): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `${COLOUR[colour]}${text}${COLOUR.reset}`;
}

function statusColour(status: string | null | undefined): keyof typeof COLOUR {
  if (status === 'success') return 'green';
  if (status === 'failure' || status === 'error') return 'red';
  return 'yellow';
}

function formatRow(row: LogRow): string {
  const time = row.createdAt ? new Date(row.createdAt).toISOString().slice(11, 19) : '--:--:--';
  const status = (row.status ?? '?').padEnd(7);
  const platform = (row.platform ?? '-').padEnd(10);
  const action = row.action ?? '-';

  const bits = [
    paint(time, 'dim'),
    paint(status, statusColour(row.status)),
    platform,
    action,
  ];

  if (row.latencyMs != null) bits.push(paint(`${row.latencyMs}ms`, 'dim'));
  if (row.httpStatus != null && row.httpStatus >= 400) bits.push(paint(`HTTP ${row.httpStatus}`, 'red'));
  if (row.targetId) bits.push(paint(`${row.targetType ?? 'target'}:${row.targetId.slice(0, 8)}`, 'dim'));

  let line = bits.join('  ');
  // The error message is the reason you opened this. Never truncated away.
  if (row.errorMessage) line += `\n           ${paint(row.errorMessage, 'red')}`;
  return line;
}

export interface LogsOptions {
  follow: boolean;
  format: Format;
  /** Passed straight through to the API — platform, action, status, … */
  filters: Record<string, unknown>;
  intervalMs?: number;
}

export async function logs(opts: LogsOptions): Promise<void> {
  const tool = requireTool('list_action_log');

  // A cursor-based tail cannot page backwards, so the first fetch doubles as
  // "what has just happened" — enough to orient, not a whole history.
  const first = (await callTool(tool, {
    ...opts.filters,
    limit: opts.filters.limit ?? (opts.follow ? 20 : 50),
  })) as unknown;

  const rows = (rowsOf(first) ?? []) as LogRow[];

  // Oldest-first for reading. The API returns newest-first, which is right for
  // a table and wrong for a log that scrolls.
  const ordered = [...rows].reverse();

  if (!opts.follow) {
    if (opts.format !== 'table') {
      const { printResult } = await import('../render/output.js');
      printResult(first, opts.format);
      return;
    }
    for (const row of ordered) process.stdout.write(`${formatRow(row)}\n`);
    if (ordered.length === 0) note('Nothing yet.');
    return;
  }

  if (opts.format === 'table') {
    note(paint('Tailing the action log. Ctrl-C to stop.', 'dim'));
  }
  for (const row of ordered) emit(row, opts.format);

  let seen = new Set(rows.map((r) => r.id).filter(Boolean) as string[]);
  let since = newestTimestamp(rows) ?? new Date().toISOString();
  const interval = opts.intervalMs ?? 3000;

  // Runs until Ctrl-C. No deadline: "leave it open while I work" is the point.
  for (;;) {
    await new Promise((r) => setTimeout(r, interval));

    let batch: LogRow[];
    try {
      const res = await callTool(tool, { ...opts.filters, since, limit: 200 });
      batch = (rowsOf(res) ?? []) as LogRow[];
    } catch (err) {
      // A tail that dies on one failed poll is a tail nobody trusts. Auth
      // failures are different: they will not fix themselves, and retrying
      // forever would hide the reason.
      if (err instanceof CliError && err.code === EXIT.unauthenticated) throw err;
      note(paint(`poll failed: ${(err as Error).message}`, 'yellow'));
      continue;
    }

    const fresh = batch.filter((r) => !r.id || !seen.has(r.id));
    if (fresh.length === 0) continue;

    for (const row of [...fresh].reverse()) emit(row, opts.format);

    const newest = newestTimestamp(fresh);
    if (newest) since = newest;

    // Only ids at the boundary can collide with the next `since`; older ones
    // can never be re-delivered, so remembering them is pure growth.
    seen = new Set(
      batch
        .filter((r) => r.createdAt === newest)
        .map((r) => r.id)
        .filter(Boolean) as string[],
    );
  }
}

function emit(row: LogRow, format: Format): void {
  if (format === 'table') {
    process.stdout.write(`${formatRow(row)}\n`);
    return;
  }
  // ndjson and json both stream a line per row here: a followed log has no
  // end, so there is no array to close.
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

function newestTimestamp(rows: LogRow[]): string | null {
  let newest: string | null = null;
  for (const r of rows) {
    if (!r.createdAt) continue;
    if (!newest || r.createdAt > newest) newest = r.createdAt;
  }
  return newest;
}
