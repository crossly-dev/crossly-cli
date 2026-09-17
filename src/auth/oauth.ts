/**
 * The two ways `crossly login` can get a token.
 *
 * ── LOOPBACK PKCE (default) ──────────────────────────────────────────
 * Open a browser, listen on 127.0.0.1, receive the code, exchange it. What
 * `gh auth login` does. Best experience when there IS a browser.
 *
 * ── DEVICE CODE (--device, or automatic fallback) ────────────────────
 * Print a short code, poll until somebody approves it elsewhere. The only flow
 * that works over SSH, in a container, or in an agent sandbox — which is most
 * of the places a CLI actually runs.
 *
 * PKCE on both. The CLI is a PUBLIC client: any secret compiled into it is in
 * every copy, so the proof-of-possession has to be per-attempt. `code_verifier`
 * is generated here, never leaves the process, and the server only ever sees
 * its SHA-256 until the exchange.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { CliError, EXIT } from '../exit.js';

/**
 * The CLI's own OAuth client id.
 *
 * Not a secret and not pretending to be one — it identifies the app on the
 * consent screen, nothing more. Overridable so a self-hosted or staging
 * deployment can point at its own registered app.
 */
export const CLI_CLIENT_ID = process.env.CROSSLY_CLIENT_ID ?? 'crossly-cli';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function toTokenSet(raw: RawTokenResponse): TokenSet {
  if (!raw.access_token) {
    throw new CliError(
      raw.error_description ?? raw.error ?? 'The server did not return an access token.',
      EXIT.unauthenticated,
      raw.error,
    );
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    // A minute of slack so a token is never used in the second it expires.
    expiresAt: raw.expires_in ? Date.now() + (raw.expires_in - 60) * 1000 : undefined,
    scope: raw.scope,
  };
}

async function postForm(url: string, body: Record<string, string>): Promise<RawTokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as RawTokenResponse;
  } catch {
    throw new CliError(`Unexpected reply from ${url}: ${text.slice(0, 200)}`, EXIT.failure);
  }
}

/** Best-effort browser open. Never fatal — the URL is always printed too. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* printed instead */
  }
}

// ── Loopback PKCE ────────────────────────────────────────────────────────

export interface LoopbackResult {
  tokens: TokenSet;
}

/**
 * Run the authorization-code flow against a loopback listener.
 *
 * Port 0: the OS picks a free one. A hard-coded port collides with whatever
 * else the developer is running and fails at the worst moment — mid-login,
 * with a half-open browser tab.
 */
export async function loginWithLoopback(args: {
  apiBase: string;
  webBase: string;
  scopes: string[];
  onUrl: (url: string) => void;
  timeoutMs?: number;
}): Promise<LoopbackResult> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');

  const { server, port, waitForCode } = await startLoopbackServer(state, args.timeoutMs ?? 300_000);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authorizeUrl = new URL(`${args.webBase.replace(/\/$/, '')}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', CLI_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', args.scopes.join(' '));
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  args.onUrl(authorizeUrl.toString());

  try {
    const code = await waitForCode;
    const raw = await postForm(`${args.apiBase.replace(/\/$/, '')}/oauth/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: CLI_CLIENT_ID,
    });
    return { tokens: toTokenSet(raw) };
  } finally {
    server.close();
  }
}

function startLoopbackServer(
  expectedState: string,
  timeoutMs: number,
): Promise<{ server: import('node:http').Server; port: number; waitForCode: Promise<string> }> {
  return new Promise((resolveServer, rejectServer) => {
    let settle: ((code: string) => void) | null = null;
    let fail: ((err: Error) => void) | null = null;
    const waitForCode = new Promise<string>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const timer = setTimeout(() => {
      fail?.(new CliError('Timed out waiting for the browser.', EXIT.unauthenticated));
    }, timeoutMs);
    timer.unref?.();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      // Checked before the code is touched. Without this, any page the user
      // visits could drive this listener and swap in a code for an account
      // that is not theirs.
      if (!state || state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('State mismatch. Login aborted.');
        clearTimeout(timer);
        fail?.(new CliError('State mismatch — login aborted.', EXIT.unauthenticated));
        return;
      }

      if (err || !code) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`Login failed: ${err ?? 'no code'}`);
        clearTimeout(timer);
        fail?.(new CliError(`Authorization failed: ${err ?? 'no code returned'}`, EXIT.unauthenticated));
        return;
      }

      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset="utf-8"><title>Crossly</title>' +
          '<body style="font:16px system-ui;padding:3rem;max-width:32rem">' +
          '<h1>Signed in</h1><p>You can close this tab and go back to your terminal.</p>');
      clearTimeout(timer);
      settle?.(code);
    });

    server.on('error', rejectServer);
    // 127.0.0.1, not 0.0.0.0 — the callback carries an authorization code and
    // has no business being reachable from the network.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectServer(new CliError('Could not open a local callback port.', EXIT.failure));
        return;
      }
      resolveServer({ server, port: addr.port, waitForCode });
    });
  });
}

// ── Device code ──────────────────────────────────────────────────────────

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export async function startDeviceLogin(args: {
  apiBase: string;
  scopes: string[];
}): Promise<DeviceStart> {
  const raw = (await postForm(`${args.apiBase.replace(/\/$/, '')}/oauth/device_authorization`, {
    client_id: CLI_CLIENT_ID,
    scope: args.scopes.join(' '),
  })) as RawTokenResponse & {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };

  if (raw.error || !raw.device_code || !raw.user_code) {
    throw new CliError(
      raw.error_description ?? raw.error ?? 'Could not start a device login.',
      EXIT.unauthenticated,
      raw.error,
    );
  }

  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri: raw.verification_uri ?? '',
    verificationUriComplete: raw.verification_uri_complete ?? raw.verification_uri ?? '',
    intervalSeconds: raw.interval ?? 5,
    expiresInSeconds: raw.expires_in ?? 600,
  };
}

/**
 * Poll until approved, denied, or expired.
 *
 * `slow_down` widens the interval permanently rather than for one tick — RFC
 * 8628 §3.5 treats it as the server raising the floor, and a client that
 * snapped back to the old interval would earn it again immediately.
 */
export async function pollDeviceLogin(args: {
  apiBase: string;
  start: DeviceStart;
  signal?: AbortSignal;
}): Promise<TokenSet> {
  let intervalMs = args.start.intervalSeconds * 1000;
  const deadline = Date.now() + args.start.expiresInSeconds * 1000;

  for (;;) {
    if (args.signal?.aborted) throw new CliError('Login cancelled.', EXIT.unauthenticated);
    if (Date.now() > deadline) {
      throw new CliError('That code expired. Run `crossly login` again.', EXIT.unauthenticated);
    }

    await new Promise((r) => setTimeout(r, intervalMs));

    const raw = await postForm(`${args.apiBase.replace(/\/$/, '')}/oauth/token`, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: args.start.deviceCode,
      client_id: CLI_CLIENT_ID,
    });

    if (!raw.error) return toTokenSet(raw);

    switch (raw.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += 5_000;
        continue;
      case 'access_denied':
        throw new CliError('The request was declined.', EXIT.unauthenticated, raw.error);
      case 'expired_token':
        throw new CliError('That code expired. Run `crossly login` again.', EXIT.unauthenticated, raw.error);
      default:
        throw new CliError(
          raw.error_description ?? raw.error,
          EXIT.unauthenticated,
          raw.error,
        );
    }
  }
}

/** Exchange a refresh token. Returns null when it is no longer accepted. */
export async function refresh(args: {
  apiBase: string;
  refreshToken: string;
}): Promise<TokenSet | null> {
  const raw = await postForm(`${args.apiBase.replace(/\/$/, '')}/oauth/token`, {
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: CLI_CLIENT_ID,
  });
  if (raw.error || !raw.access_token) return null;
  return toTokenSet(raw);
}
