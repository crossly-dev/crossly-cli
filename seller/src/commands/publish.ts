/**
 * `crossly listings publish <inventoryItemId> --to poshmark,depop`
 *
 * ── WHAT THIS ADDS OVER THE GENERATED COMMAND ────────────────────────
 * `crossly listings crosspost` already exists and already makes the call. But
 * crossposting is ASYNC: the API returns a job id per platform and the actual
 * outcome lands minutes later. The generated command therefore reports success
 * the moment the jobs are queued — which is true, and not what anybody wants
 * to know.
 *
 * This waits, and tells you per platform what happened. Publishing to five
 * marketplaces where two fail is the normal case, and "2 of 5 failed, here is
 * why" is the only useful summary of it.
 *
 * ── PARTIAL FAILURE IS THE EXPECTED OUTCOME ──────────────────────────
 * Exit 1 if any platform failed, so a script can branch. The successes are
 * still printed and still real: a partial publish must never read as a total
 * one in either direction.
 */
import { callTool, requireTool } from './run-tool.js';
import { CliError, EXIT } from '../exit.js';
import { note, printResult, type Format } from '../render/output.js';


/**
 * What `POST /v1/listings` actually returns.
 *
 * `{ listing, jobs, skipped, bulkJobId }` — the id is nested under `listing`,
 * NOT on the top level. This was written as `queued.listingId ?? queued.id`
 * from memory, and both are undefined for this response, so `publish` silently
 * skipped the wait that is its entire reason to exist. The other shapes are
 * kept as fallbacks because the same tool name may front a different route
 * later, and the failure mode of guessing wrong is invisible.
 */
interface CrosspostResponse {
  listing?: { id?: string } | null;
  listingId?: string;
  id?: string;
  jobs?: Array<{ platform?: string; jobId?: string }>;
  skipped?: unknown[];
}

interface SkippedOutcome {
  platform: string;
  status: 'skipped';
  error: string | null;
}

function listingIdOf(res: CrosspostResponse | null): string | undefined {
  return res?.listing?.id ?? res?.listingId ?? res?.id;
}

/** `skipped` entries are either a platform slug or `{platform, reason}`. */
function normalizeSkip(entry: unknown): SkippedOutcome | null {
  if (typeof entry === 'string') return { platform: entry, status: 'skipped', error: null };
  if (entry && typeof entry === 'object') {
    const e = entry as { platform?: string; reason?: string; message?: string };
    if (e.platform) {
      return { platform: e.platform, status: 'skipped', error: e.reason ?? e.message ?? null };
    }
  }
  return null;
}

interface PlatformOutcome {
  platform: string;
  status: 'live' | 'failed' | 'pending' | 'skipped';
  url?: string | null;
  error?: string | null;
}

export interface PublishOptions {
  inventoryItemId: string;
  platforms: string[];
  format: Format;
  /** Queue the jobs and return without waiting. */
  noWait?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export async function publish(opts: PublishOptions): Promise<number> {
  if (opts.platforms.length === 0) {
    throw new CliError('Give at least one platform: --to poshmark,depop', EXIT.usage, 'usage');
  }

  const crosspost = requireTool('crosspost_listing');
  const queued = (await callTool(crosspost, {
    inventoryItemId: opts.inventoryItemId,
    platforms: opts.platforms,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  })) as CrosspostResponse | null;

  const listingId = listingIdOf(queued);

  // Platforms the server declined before any job was queued — already listed
  // there, not connected, unsupported. Reported as their own outcome rather
  // than left to time out as "pending", which would tell the user to go look
  // for a job that was never created.
  const skipped = (queued?.skipped ?? []).map(normalizeSkip).filter(Boolean) as SkippedOutcome[];
  const skippedNames = new Set(skipped.map((s) => s.platform));
  const awaited = opts.platforms.filter((p) => !skippedNames.has(p));

  if (opts.noWait || !listingId) {
    if (!listingId && !opts.noWait) {
      // Without a listing id there is nothing to poll. Say so rather than
      // silently degrading to fire-and-forget, which would look identical to
      // a successful wait that found nothing wrong.
      note('Queued, but the API returned no listing id — cannot follow the jobs.');
    }
    printResult(queued ?? { queued: true }, opts.format);
    return EXIT.ok;
  }

  if (opts.format === 'table') {
    note(`Publishing to ${opts.platforms.join(', ')}…`);
  }

  const outcomes = await waitForPlatforms({
    listingId,
    platforms: awaited,
    timeoutMs: opts.timeoutMs ?? 180_000,
    onProgress: (o) => {
      if (opts.format !== 'table') return;
      const mark = o.status === 'live' ? '✓' : o.status === 'failed' ? '✗' : '·';
      note(`  ${mark} ${o.platform}${o.error ? ` — ${o.error}` : ''}`);
    },
  });

  const all = [...outcomes, ...skipped];
  for (const s of skipped) {
    if (opts.format === 'table') note(`  – ${s.platform} skipped${s.error ? ` — ${s.error}` : ''}`);
  }
  printResult({ listingId, platforms: all }, opts.format);

  const failed = all.filter((o) => o.status === 'failed');
  if (failed.length > 0) {
    if (opts.format === 'table') {
      note(`${failed.length} of ${all.length} failed.`);
    }
    return EXIT.failure;
  }

  // Still pending at the deadline is NOT success. A job that has not finished
  // may still fail, and reporting 0 here would let a script move on.
  const pending = all.filter((o) => o.status === 'pending');
  if (pending.length > 0) {
    if (opts.format === 'table') {
      note(`${pending.length} still running — check \`crossly logs -f\`.`);
    }
    return EXIT.failure;
  }

  return EXIT.ok;
}

async function waitForPlatforms(args: {
  listingId: string;
  platforms: string[];
  timeoutMs: number;
  onProgress: (o: PlatformOutcome) => void;
}): Promise<PlatformOutcome[]> {
  const getListing = requireTool('get_listing');
  const deadline = Date.now() + args.timeoutMs;
  const settled = new Map<string, PlatformOutcome>();

  while (Date.now() < deadline && settled.size < args.platforms.length) {
    await new Promise((r) => setTimeout(r, 3000));

    type ListingShape = { platformListings?: Array<Record<string, unknown>> };
    let listing: ListingShape | null = null;
    try {
      listing = (await callTool(getListing, { id: args.listingId })) as ListingShape | null;
    } catch (err) {
      // One failed poll is not a failed publish; the jobs are running
      // server-side regardless of whether we can see them this second.
      if (err instanceof CliError && err.code === EXIT.unauthenticated) throw err;
      continue;
    }

    for (const row of listing?.platformListings ?? []) {
      const platform = String(row.platform ?? '');
      if (!args.platforms.includes(platform) || settled.has(platform)) continue;

      const status = String(row.status ?? '');
      if (status === 'active' || status === 'live') {
        const o: PlatformOutcome = { platform, status: 'live', url: (row.url as string) ?? null };
        settled.set(platform, o);
        args.onProgress(o);
      } else if (status === 'failed' || status === 'error') {
        const o: PlatformOutcome = {
          platform,
          status: 'failed',
          error: (row.lastError as string) ?? (row.errorMessage as string) ?? null,
        };
        settled.set(platform, o);
        args.onProgress(o);
      }
    }
  }

  return args.platforms.map(
    (p) => settled.get(p) ?? { platform: p, status: 'pending' as const },
  );
}
