/**
 * `crossly orders ship <id>` — rates, label, tracking, as one verb.
 *
 * ── WHY IT IS ONE COMMAND ────────────────────────────────────────────
 * Shipping an order is three calls that must happen in order and share state:
 * `order_rates` returns rate ids, `order_label` buys one, and the label's
 * tracking number then goes back to the marketplace with `submit_tracking`.
 * Done by hand that is three commands and two copy-pastes, and the middle step
 * SPENDS MONEY — which is exactly the sequence you do not want a person
 * assembling from a shell history at 11pm.
 *
 * ── BUYING IS NEVER IMPLICIT ─────────────────────────────────────────
 * Without `--yes` this stops after rates and prints them. A command that
 * silently bought postage because you forgot a flag would be the worst bug in
 * this CLI, so the default is the safe half and the spend is opt-in.
 *
 * `--rate` picks a specific rate id; otherwise the cheapest is chosen and
 * NAMED before purchase, so "cheapest" is a stated decision rather than an
 * assumption.
 */
import { callTool, requireTool } from './run-tool.js';
import { CliError, EXIT } from '../exit.js';
import { note, printResult, renderTable, type Format } from '../render/output.js';

interface Rate {
  id?: string;
  rateId?: string;
  carrier?: string;
  service?: string;
  amount?: number | string;
  currency?: string;
  estimatedDays?: number | null;
}

export interface ShipOptions {
  orderId: string;
  format: Format;
  /** Actually buy the label. Without it, rates are shown and nothing is spent. */
  confirm?: boolean;
  rateId?: string;
  idempotencyKey?: string;
  /** Parcel dimensions, when the order has no preset. */
  parcel?: Record<string, unknown>;
}

function amountOf(r: Rate): number {
  const raw = r.amount ?? Number.POSITIVE_INFINITY;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function idOf(r: Rate): string | undefined {
  return r.rateId ?? r.id;
}

export async function ship(opts: ShipOptions): Promise<number> {
  const rates = (await callTool(requireTool('order_rates'), {
    id: opts.orderId,
    ...(opts.parcel ?? {}),
  })) as { rates?: Rate[] } | Rate[] | null;

  const list: Rate[] = Array.isArray(rates) ? rates : (rates?.rates ?? []);
  if (list.length === 0) {
    throw new CliError(
      'No shipping rates came back for that order. Check the parcel dimensions and the ship-from address.',
      EXIT.failure,
      'no_rates',
    );
  }

  if (!opts.confirm) {
    // The safe half. Printed as a table even under --json? No: honour the
    // format, because a script asking for rates wants to choose one itself.
    if (opts.format === 'table') {
      note('Rates for this order. Nothing has been bought.');
      process.stdout.write(`${renderTable(list)}\n`);
      note('');
      note('Buy one with:  crossly orders ship <id> --yes [--rate <rateId>]');
    } else {
      printResult({ orderId: opts.orderId, rates: list, purchased: false }, opts.format);
    }
    return EXIT.ok;
  }

  const chosen = opts.rateId
    ? list.find((r) => idOf(r) === opts.rateId)
    : [...list].sort((a, b) => amountOf(a) - amountOf(b))[0];

  if (!chosen || !idOf(chosen)) {
    throw new CliError(
      opts.rateId
        ? `No rate with id "${opts.rateId}". Run without --yes to see the ids.`
        : 'Could not pick a rate from the response.',
      EXIT.usage,
      'unknown_rate',
    );
  }

  if (opts.format === 'table') {
    // Named before the money moves. "Cheapest" is a decision, and the user
    // should see which one it landed on before it is charged.
    note(
      `Buying ${chosen.carrier ?? '?'} ${chosen.service ?? ''} — ${chosen.currency ?? '$'}${
        chosen.amount ?? '?'
      }`.trim(),
    );
  }

  const label = (await callTool(requireTool('order_label'), {
    id: opts.orderId,
    rateId: idOf(chosen),
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  })) as { trackingNumber?: string; carrier?: string; labelUrl?: string } | null;

  const tracking = label?.trackingNumber;
  if (!tracking) {
    // The label may well have been bought. Saying so matters: retrying would
    // buy a second one, and the user needs to know to check rather than retry.
    throw new CliError(
      'The label was purchased but no tracking number came back. Check the order before retrying — a retry buys another label.',
      EXIT.failure,
      'label_without_tracking',
    );
  }

  const submitted = await callTool(requireTool('submit_tracking'), {
    id: opts.orderId,
    trackingNumber: tracking,
    carrier: (label?.carrier ?? chosen.carrier ?? '').toLowerCase(),
    // Derived, not required from the user: this is a retry-unsafe write and
    // the order can only be shipped once, so the order id IS the natural key.
    idempotencyKey: opts.idempotencyKey ?? `ship-${opts.orderId}-${tracking}`,
  });

  printResult(
    {
      orderId: opts.orderId,
      rate: { id: idOf(chosen), carrier: chosen.carrier, service: chosen.service, amount: chosen.amount },
      trackingNumber: tracking,
      labelUrl: label?.labelUrl ?? null,
      trackingSubmitted: submitted !== null,
    },
    opts.format,
  );
  return EXIT.ok;
}
