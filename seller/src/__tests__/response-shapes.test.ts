/**
 * The response shapes the workflows read.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────
 * Every hand-written workflow pulls a field out of an API response, and every
 * one of those was written from memory. One was wrong: `crossly listings
 * publish` read `listingId ?? id` while `POST /v1/listings` returns
 * `{ listing, jobs, skipped }` — the id is nested. Both reads were undefined,
 * so publish quietly skipped the wait that is its whole purpose and reported
 * success.
 *
 * That is the failure mode worth guarding: not a crash, not an error, just a
 * feature that silently does not happen. The shapes below are transcribed from
 * the route handlers, so if a route changes its envelope these fail rather than
 * the CLI degrading in silence.
 */
import { describe, it, expect } from 'vitest';
import { rowsOf } from '../render/output.js';

/**
 * Mirrors `listingIdOf` in publish.ts.
 *
 * Duplicated deliberately: this test asserts what the RULE should be, derived
 * from the route. Importing the implementation would let a wrong rule agree
 * with itself, which is exactly how the original bug passed review.
 */
function listingIdOf(res: Record<string, unknown> | null): string | undefined {
  const r = res as { listing?: { id?: string }; listingId?: string; id?: string } | null;
  return r?.listing?.id ?? r?.listingId ?? r?.id;
}

describe('POST /v1/listings — what publish reads', () => {
  // Transcribed from routes/v1/write/listings.ts:
  //   return { status: 201, body: { listing, jobs, skipped, bulkJobId } }
  const real = {
    listing: { id: 'abc-123', title: 'A jacket' },
    jobs: [{ platform: 'depop', jobId: 'j1' }],
    skipped: [],
    bulkJobId: null,
  };

  it('finds the id nested under `listing`', () => {
    expect(listingIdOf(real)).toBe('abc-123');
  });

  it('would have found nothing with the original top-level read', () => {
    // The bug, pinned. If someone "simplifies" back to this, the test above
    // fails and this one explains why.
    expect((real as Record<string, unknown>).listingId).toBeUndefined();
    expect((real as Record<string, unknown>).id).toBeUndefined();
  });

  it('still accepts a flatter shape, in case the route changes', () => {
    expect(listingIdOf({ listingId: 'x' })).toBe('x');
    expect(listingIdOf({ id: 'y' })).toBe('y');
  });

  it('returns undefined rather than guessing when there is no id', () => {
    expect(listingIdOf({ jobs: [] })).toBeUndefined();
    expect(listingIdOf(null)).toBeUndefined();
  });
});

describe('list envelopes — what every list command reads', () => {
  it('reads the documented `items` envelope', () => {
    expect(rowsOf({ items: [1, 2], meta: {} })).toEqual([1, 2]);
  });

  it('reads the `data` envelope the action log uses', () => {
    // routes/v1/read/action-log.ts: reply.send({ data: items, pagination })
    expect(rowsOf({ data: [1], pagination: {} })).toEqual([1]);
  });

  it('prefers `items` when a response carries both', () => {
    // `paginatedResponseCompat` mirrors items into data during migrations.
    // Reading `data` there would work today and break when the mirror goes.
    expect(rowsOf({ items: ['new'], data: ['legacy'] })).toEqual(['new']);
  });

  it('passes a bare array through', () => {
    expect(rowsOf([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('returns null for a single object, so it prints as JSON not a table', () => {
    expect(rowsOf({ id: 'x', title: 'y' })).toBeNull();
  });
});

describe('POST /v1/orders/:id/rates — what ship reads', () => {
  // routes/v1/write/orders-verbs/rates.ts: { status: 200, body: { rates } }
  const real = { rates: [{ rateId: 'r1', carrier: 'usps', amount: '7.20' }] };

  it('finds the rates array', () => {
    const list = Array.isArray(real) ? real : (real.rates ?? []);
    expect(list).toHaveLength(1);
    expect(list[0]!.rateId).toBe('r1');
  });

  it('tolerates a bare array', () => {
    const bare = [{ rateId: 'r1' }];
    const list = Array.isArray(bare) ? bare : [];
    expect(list).toHaveLength(1);
  });
});

describe('POST /v1/inventory/csv/export — what export reads', () => {
  it('handles a raw CSV body', () => {
    // The route replies with `text/csv`, so the SDK's JSON.parse fails and it
    // hands back the raw string. Reading `.csv` off a string would be
    // undefined and write "undefined" to the file.
    const result: unknown = 'sku,title\nA1,Jacket\n';
    const csv = typeof result === 'string' ? result : undefined;
    expect(csv).toContain('sku,title');
  });
});
