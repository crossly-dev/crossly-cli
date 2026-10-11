/**
 * `crossly dev --forward http://localhost:3000/webhooks`
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────
 * Holds an SSE connection to Crossly and re-POSTs every webhook event to a URL
 * on your machine. You can build a webhook handler against real events without
 * deploying anything and without a tunnel — nothing about this machine has to
 * be reachable from the internet, because the connection is outbound.
 *
 * ── WHY IT RECONNECTS, AND WHY IT BACKS OFF ──────────────────────────
 * This is meant to be left running all day. Laptops sleep, wifi drops, and the
 * server restarts on deploy; a version that exited on the first dropped
 * connection would be useless for the thing it exists for. It backs off up to
 * 30s so a server that is genuinely down is not hammered by every developer
 * who left this open.
 *
 * ── A FAILING LOCAL HANDLER IS NOT A FAILING STREAM ──────────────────
 * If the local POST 500s, that is reported and the stream continues. You are
 * developing that handler — it failing is the normal case, and a forwarder
 * that quit every time your code threw would be unusable.
 */
import { resolveAuth, apiBase } from '../client.js';
import { CliError, EXIT } from '../exit.js';
import { note } from '../render/output.js';

export interface DevOptions {
  /** Local URL to POST events to. Omit to only print them. */
  forward?: string;
  /** Only forward these event names. */
  events?: string[];
  quiet?: boolean;
}

interface StreamEvent {
  eventName: string;
  eventId: string;
  createdAt: string;
  payload: unknown;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Is this forward target on this machine?
 *
 * Webhook payloads carry order totals, buyer names and shipping addresses.
 * A `--forward` pointed at someone else's host would ship all of it off the
 * machine continuously, and the whole premise of this command is that nothing
 * has to leave. Exported so the rule is tested rather than trusted.
 */
export function checkForwardTarget(forward: string, allowRemote: boolean): void {
  let url: URL;
  try {
    url = new URL(forward);
  } catch {
    throw new CliError(`--forward is not a URL: ${forward}`, EXIT.usage, 'usage');
  }

  // Hostname equality, never `includes` or `endsWith`: `127.0.0.1.evil.test`
  // and `localhost.evil.test` both resolve to somebody else's server and both
  // pass a sloppy check.
  const local =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' ||
    url.hostname === '[::1]';

  if (!local && !allowRemote) {
    throw new CliError(
      `--forward points at ${url.hostname}, not this machine. ` +
        'Webhook payloads carry order and buyer data.\n' +
        'Set CROSSLY_DEV_ALLOW_REMOTE=1 if you really mean it.',
      EXIT.usage,
      'remote_forward',
    );
  }
}

export async function dev(opts: DevOptions): Promise<number> {
  if (opts.forward) {
    checkForwardTarget(opts.forward, Boolean(process.env.CROSSLY_DEV_ALLOW_REMOTE));
  }

  const { token } = await resolveAuth();
  const streamUrl = `${apiBase().replace(/\/$/, '')}/v1/webhooks/stream`;

  note(`Listening for webhook events…`);
  if (opts.forward) note(`  forwarding to ${opts.forward}`);
  if (opts.events?.length) note(`  only: ${opts.events.join(', ')}`);
  note('  Ctrl-C to stop.');

  let backoff = 1000;

  for (;;) {
    try {
      await streamOnce({ streamUrl, token, opts, onConnected: () => { backoff = 1000; } });
      // A clean end means the server closed the stream — reconnect promptly,
      // this is the deploy case.
      note('Stream ended; reconnecting…');
    } catch (err) {
      if (err instanceof CliError && err.code === EXIT.unauthenticated) throw err;
      note(`Disconnected: ${(err as Error).message}`);
    }

    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

async function streamOnce(args: {
  streamUrl: string;
  token: string;
  opts: DevOptions;
  onConnected: () => void;
}): Promise<void> {
  const res = await fetch(args.streamUrl, {
    headers: { authorization: `Bearer ${args.token}`, accept: 'text/event-stream' },
  });

  if (res.status === 401) {
    throw new CliError('Not signed in. Run `crossly login`.', EXIT.unauthenticated, 'unauthenticated');
  }
  if (res.status === 403) {
    throw new CliError(
      'This token lacks the webhooks:read scope. Run `crossly login` again.',
      EXIT.forbiddenScope,
      'insufficient_scope',
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`stream returned ${res.status}`);
  }

  args.onConnected();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Split on that, keeping the
    // trailing partial — a frame can and does arrive across two chunks, and
    // parsing per-chunk would drop every event that happened to straddle one.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data) continue; // heartbeat or comment

      let event: StreamEvent;
      try {
        event = JSON.parse(data) as StreamEvent;
      } catch {
        continue;
      }
      if (!event.eventName) continue; // the `ready` frame

      if (args.opts.events?.length && !args.opts.events.includes(event.eventName)) continue;

      await handle(event, args.opts);
    }
  }
}

async function handle(event: StreamEvent, opts: DevOptions): Promise<void> {
  const stamp = new Date(event.createdAt).toISOString().slice(11, 19);

  if (!opts.forward) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  try {
    const res = await fetch(opts.forward, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Named so a handler can tell a forwarded event from a real delivery —
        // useful when the same endpoint serves both in staging.
        'x-crossly-event': event.eventName,
        'x-crossly-event-id': event.eventId,
        'x-crossly-forwarded-by': 'crossly-cli',
      },
      body: JSON.stringify(event.payload),
    });

    if (!opts.quiet) {
      const ok = res.ok ? '→' : '✗';
      note(`${stamp}  ${ok} ${event.eventName} → ${res.status}`);
    }
  } catch (err) {
    // Your handler not being up yet is the normal state at the start of a
    // session. Reported, never fatal.
    note(`${stamp}  ✗ ${event.eventName} → ${(err as Error).message}`);
  }
}
