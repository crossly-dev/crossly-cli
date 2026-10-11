/**
 * Rendering.
 *
 * Two modes and no cleverness: `--json` prints exactly what the API returned,
 * anything else prints a table a person can read. The JSON mode must stay
 * byte-faithful — a script piping to `jq` is the second-biggest consumer of
 * this tool after a human, and reshaping "helpfully" breaks it silently.
 */

export interface RenderOpts {
  json?: boolean;
  ndjson?: boolean;
}

/** The rows inside a `{ data, meta }` envelope, or the value itself. */
function rowsOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return null;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}]` : '{…}';
  return String(v);
}

/**
 * Money arrives from this API in CENTS, always. Rendering 4500 as "4500" in a
 * column headed `amountCents` is technically honest and reads as $4,500 to
 * every human who glances at it, so columns ending in `Cents` are formatted.
 */
function isMoneyColumn(key: string): boolean {
  return /cents$/i.test(key);
}

function formatMoney(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return cell(v);
  return `$${(n / 100).toFixed(2)}`;
}

function table(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '(none)';

  // Union of keys, so a row missing a field still lines up.
  const keys: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);

  const render = (row: Record<string, unknown>, k: string): string =>
    isMoneyColumn(k) ? formatMoney(row[k]) : cell(row[k]);

  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => render(r, k).length)),
  );

  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').replace(/\s+$/, '');

  return [
    line(keys),
    line(widths.map((w) => '─'.repeat(w))),
    ...rows.map((r) => line(keys.map((k) => render(r, k)))),
  ].join('\n');
}

export function render(value: unknown, opts: RenderOpts = {}): string {
  if (opts.json) return JSON.stringify(value, null, 2);

  if (opts.ndjson) {
    const rows = rowsOf(value);
    if (rows) return rows.map((r) => JSON.stringify(r)).join('\n');
    return JSON.stringify(value);
  }

  const rows = rowsOf(value);
  if (rows) {
    const objects = rows.filter(
      (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r),
    );
    if (objects.length === rows.length) return table(objects);
  }

  // A single object renders as key/value pairs rather than a one-row table —
  // a profile with twelve fields is unreadable sideways.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = (value as { data?: unknown }).data ?? value;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const entries = Object.entries(obj as Record<string, unknown>);
      const w = Math.max(...entries.map(([k]) => k.length), 0);
      return entries
        .map(([k, v]) => `${k.padEnd(w)}  ${isMoneyColumn(k) ? formatMoney(v) : cell(v)}`)
        .join('\n');
    }
  }

  return String(value);
}
