/**
 * How results reach stdout.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────
 * stdout carries the RESULT. stderr carries everything about the result —
 * progress, warnings, the reason something failed. That split is what lets
 * `crossly orders list --json | jq` work while the user still sees what is
 * happening, and it is why nothing here ever prints a status line to stdout.
 *
 * Three formats, because three callers want different things:
 *
 *   table   a person reading a terminal          (default when tty)
 *   json    a script that will parse it once     (default when piped)
 *   ndjson  a consumer streaming a long list     (one row per line)
 *
 * Defaulting to json when stdout is not a tty is the behaviour people expect
 * from `gh` and `kubectl`: a pipe means a program is reading, and a program
 * should not have to strip a box-drawing table.
 */
export type Format = 'table' | 'json' | 'ndjson';

export function defaultFormat(): Format {
  return process.stdout.isTTY ? 'table' : 'json';
}

/** Rows out of a list response, whatever the endpoint called its array. */
export function rowsOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    // `items` is the documented list envelope; `data` is the legacy mirror
    // kept during migrations. Checked in that order so a response carrying
    // both is read the modern way.
    for (const key of ['items', 'data', 'results', 'rows']) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return null;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects collapse rather than exploding the table. Anyone who needs the
  // nested shape wants --json, and printing it inline makes every column wrong.
  if (Array.isArray(value)) return `[${value.length}]`;
  return '{…}';
}

/**
 * Columns for a table, chosen from the first row.
 *
 * Preferred keys first so the useful ones survive the width limit — an `id`
 * column that scrolled off because the row happened to start with
 * `createdAt` is a table nobody can act on.
 */
const PREFERRED = ['id', 'sku', 'title', 'name', 'status', 'platform', 'price', 'quantity'];
const MAX_COLUMNS = 6;

function columnsFor(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 20)) for (const k of Object.keys(row)) keys.add(k);

  const ordered = [
    ...PREFERRED.filter((k) => keys.has(k)),
    ...[...keys].filter((k) => !PREFERRED.includes(k)),
  ];
  return ordered.slice(0, MAX_COLUMNS);
}

export function renderTable(rows: unknown[]): string {
  if (rows.length === 0) return 'No results.';

  const objects = rows.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r),
  );
  // A list of scalars is a list, not a table.
  if (objects.length === 0) return rows.map((r) => cell(r)).join('\n');

  const cols = columnsFor(objects);
  const header = cols.map((c) => c.toUpperCase());
  const body = objects.map((row) => cols.map((c) => cell(row[c])));

  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i]!.length), 3),
  );
  // Capped so one long description cannot push every other column off screen.
  const capped = widths.map((w) => Math.min(w, 40));

  const line = (cells: string[]) =>
    cells
      .map((c, i) => (c.length > capped[i]! ? `${c.slice(0, capped[i]! - 1)}…` : c.padEnd(capped[i]!)))
      .join('  ')
      .trimEnd();

  return [line(header), ...body.map(line)].join('\n');
}

/** Print a result in the requested format. Always to stdout, never decorated. */
export function printResult(value: unknown, format: Format): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (format === 'ndjson') {
    const rows = rowsOf(value);
    // A non-list under --ndjson is still one JSON value on one line, rather
    // than an error: a caller streaming a mixed set of commands should not
    // have to special-case the ones that return an object.
    for (const row of rows ?? [value]) process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }

  const rows = rowsOf(value);
  if (rows) {
    process.stdout.write(`${renderTable(rows)}\n`);
    return;
  }
  // Single objects print as JSON even in table mode. A two-column key/value
  // rendering loses nesting, and this is the shape people pipe into jq.
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Progress, warnings, anything that is not the result. */
export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}
