/**
 * `crossly login` / `logout` / `whoami`.
 *
 * ── CHOOSING A FLOW ──────────────────────────────────────────────────
 * Loopback PKCE when a browser is plausible, device code otherwise. The
 * fallback is automatic rather than a flag the user has to know about: the
 * machines that cannot do loopback — SSH, containers, agent sandboxes — are
 * exactly the ones where the person has no idea why a browser never opened.
 *
 * `--device` forces the second flow for the case the detection misses.
 */
import { CliError, EXIT } from '../exit.js';
import { apiBase, webBase, resolveAuth } from '../client.js';
import { clearAuth, envToken, readAuth, writeAuth, authPath } from '../auth/store.js';
import {
  loginWithLoopback,
  openBrowser,
  pollDeviceLogin,
  startDeviceLogin,
} from '../auth/oauth.js';
import { note, printResult, type Format } from '../render/output.js';
import { CLI_SCOPES } from '../scopes.js';


/**
 * Is a browser plausible here?
 *
 * SSH_CONNECTION is the strong signal — a remote shell has no browser to open
 * and the loopback listener would be on the wrong machine entirely, so the
 * callback could never arrive. `DISPLAY` covers bare Linux. CI is included
 * because an automated run must never sit waiting on a consent screen.
 */
function browserLikely(): boolean {
  if (process.env.CI) return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false;
  }
  return true;
}

export async function login(raw: Record<string, string | boolean>, format: Format): Promise<void> {
  if (envToken()) {
    // Logging in would write a token that the env var then shadows on every
    // command — a session that exists and is never used.
    note('CROSSLY_PAT is set; it takes precedence over a stored session.');
    note('Unset it first if you want `crossly login` to take effect.');
  }

  const useDevice = raw.device === true || !browserLikely();
  const tokens = useDevice
    ? await deviceFlow()
    : (
        await loginWithLoopback({
          apiBase: apiBase(),
          webBase: webBase(),
          scopes: CLI_SCOPES,
          onUrl: (url) => {
            note('Opening your browser to sign in…');
            note(`If it did not open: ${url}`);
            openBrowser(url);
          },
        })
      ).tokens;

  writeAuth({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    baseUrl: apiBase(),
  });

  note(`Signed in. Token stored at ${authPath()}.`);
  printResult({ ok: true, storedAt: authPath() }, format);
}

async function deviceFlow() {
  const start = await startDeviceLogin({ apiBase: apiBase(), scopes: CLI_SCOPES });

  // stderr, so `crossly login --json` still emits only the result on stdout.
  note('');
  note(`  Open:  ${start.verificationUri}`);
  note(`  Code:  ${start.userCode}`);
  note('');
  note('Waiting for approval…');

  if (browserLikely() && start.verificationUriComplete) {
    openBrowser(start.verificationUriComplete);
  }

  return pollDeviceLogin({ apiBase: apiBase(), start });
}

export async function logout(format: Format): Promise<void> {
  const had = readAuth() !== null;
  clearAuth();
  if (envToken()) {
    // Clearing the file cannot unset an env var, and saying "signed out" while
    // the next command still works would be a lie.
    note('Removed the stored session, but CROSSLY_PAT is still set in this shell.');
  }
  printResult({ ok: true, hadSession: had }, format);
}

export async function whoami(format: Format): Promise<void> {
  const { token, source } = await resolveAuth();

  // Asked of the API rather than read from the file: the point of `whoami` is
  // "who does the server think I am", and a cached answer would still look
  // right after the token was revoked.
  const { client } = await import('../client.js');
  const c = await client();
  let account: unknown;
  try {
    account = await c.raw.request({ method: 'GET', path: '/v1/me' });
  } catch (err) {
    throw new CliError(
      `That token is not accepted: ${(err as Error).message}`,
      EXIT.unauthenticated,
    );
  }

  printResult(
    {
      account,
      tokenSource: source === 'env' ? 'CROSSLY_PAT' : authPath(),
      tokenPrefix: `${token.slice(0, 16)}…`,
      apiBase: apiBase(),
    },
    format,
  );
}
