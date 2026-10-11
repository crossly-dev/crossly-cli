/**
 * `crossly inventory import <file>` / `crossly inventory export [file]`
 *
 * ── WHY THESE ARE HAND-WRITTEN ───────────────────────────────────────
 * The generated commands exist and are unusable for this: the API takes and
 * returns CSV as a STRING, so `crossly inventory import-csv --csv "$(cat
 * items.csv)"` is the generated form. That breaks on any file large enough to
 * matter — argv has a hard size limit — and mangles embedded newlines and
 * quoting on the way through the shell.
 *
 * Reading the file in the process is the whole difference, and it is the
 * difference between a command that works on 40 rows and one that works on
 * 4000.
 *
 * ── IMPORT DRY-RUNS BY DEFAULT ───────────────────────────────────────
 * A bad CSV import is among the most destructive things this API can do, and
 * it is the kind of mistake you only see afterwards. So `--yes` is required to
 * write; without it the file is validated and the server's verdict is printed.
 * That is the same shape as `orders ship`, for the same reason.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { callTool, requireTool } from './run-tool.js';
import { CliError, EXIT } from '../exit.js';
import { note, printResult, type Format } from '../render/output.js';

export interface ImportOptions {
  file: string;
  format: Format;
  /** Actually write. Without it the server validates and reports. */
  confirm?: boolean;
  idempotencyKey?: string;
}

export async function importCsv(opts: ImportOptions): Promise<number> {
  let csv: string;
  try {
    csv = readFileSync(opts.file, 'utf8');
  } catch (err) {
    throw new CliError(`Could not read ${opts.file}: ${(err as Error).message}`, EXIT.usage, 'file_unreadable');
  }

  if (csv.trim().length === 0) {
    // An empty file that reached the API would be reported as "0 rows
    // imported" — a success that looks like nothing happened, because nothing
    // did. Catch it here where the reason is obvious.
    throw new CliError(`${opts.file} is empty.`, EXIT.usage, 'empty_file');
  }

  const dryRun = !opts.confirm;
  const result = await callTool(requireTool('import_inventory_csv'), {
    csv,
    dryRun,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });

  if (opts.format === 'table') {
    note(
      dryRun
        ? 'Validated only — nothing was written. Re-run with --yes to import.'
        : 'Imported.',
    );
  }
  printResult(result ?? { ok: true, dryRun }, opts.format);

  // A dry run that found problems should not exit 0: a script gating an import
  // on `crossly inventory import x.csv` needs the failure.
  const errors = (result as { errors?: unknown[] } | null)?.errors;
  if (Array.isArray(errors) && errors.length > 0) return EXIT.failure;
  return EXIT.ok;
}

export interface ExportOptions {
  file?: string;
  format: Format;
  itemIds?: string[];
}

export async function exportCsv(opts: ExportOptions): Promise<number> {
  const result = await callTool(requireTool('export_inventory_csv'), {
    ...(opts.itemIds?.length ? { itemIds: opts.itemIds } : {}),
  });

  // The endpoint may return the CSV as a bare string or wrapped. Both are
  // handled rather than assuming: a wrong guess writes "[object Object]" to
  // the file and nobody notices until they open it.
  const csv =
    typeof result === 'string'
      ? result
      : ((result as { csv?: string; data?: string } | null)?.csv ??
        (result as { data?: string } | null)?.data);

  if (typeof csv !== 'string') {
    throw new CliError(
      'The API did not return CSV text for this export.',
      EXIT.failure,
      'unexpected_export_shape',
    );
  }

  if (!opts.file) {
    // No path means stdout, so `crossly inventory export | head` works.
    process.stdout.write(csv.endsWith('\n') ? csv : `${csv}\n`);
    return EXIT.ok;
  }

  writeFileSync(opts.file, csv, 'utf8');
  if (opts.format === 'table') {
    const rows = csv.trim().split('\n').length - 1;
    note(`Wrote ${rows} row${rows === 1 ? '' : 's'} to ${opts.file}`);
  } else {
    printResult({ file: opts.file, bytes: Buffer.byteLength(csv) }, opts.format);
  }
  return EXIT.ok;
}
