/**
 * Turning a stored session into a working API client.
 *
 * Also the one place that decides a token is no longer usable, which is why
 * refresh lives here rather than in each command: a command that got a 401
 * halfway through a paginated walk would otherwise have to know how to recover
 * on its own, and 287 commands cannot each be trusted to.
 */
import { createClient, type CrosslyClient } from '@crossly/sdk';
import { CliError, EXIT } from './exit.js';
import { envToken, readAuth, writeAuth } from './auth/store.js';
import { refresh } from './auth/oauth.js';

export const DEFAULT_API_BASE = 'https://crossly.net/api';

export function apiBase(): string {
  return process.env.CROSSLY_API_BASE_URL ?? readAuth()?.baseUrl ?? DEFAULT_API_BASE;
}

/** The web origin, derived from the API base so a staging login stays on staging. */
export function webBase(): string {
  const explicit = process.env.CROSSLY_WEB_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  return apiBase().replace(/\/api$/, '');
}

export interface ResolvedAuth {
  token: string;
  /** Where it came from, so `whoami` can tell the user what it is trusting. */
  source: 'env' | 'file';
}

/**
 * Find a usable token, refreshing an expired one if we can.
 *
 * `CROSSLY_PAT` wins. A CI job that sets it must not silently pick up a
 * developer token baked into the image, and an env var is the only credential
 * the user can see at the point of use.
 */
export async function resolveAuth(): Promise<ResolvedAuth> {
  const fromEnv = envToken();
  if (fromEnv) return { token: fromEnv, source: 'env' };

  const stored = readAuth();
  if (!stored) {
    throw new CliError(
      'Not signed in. Run `crossly login` (or set CROSSLY_PAT).',
      EXIT.unauthenticated,
      'unauthenticated',
    );
  }

  const expired = stored.expiresAt !== undefined && Date.now() >= stored.expiresAt;
  if (!expired) return { token: stored.accessToken, source: 'file' };

  if (!stored.refreshToken) {
    throw new CliError(
      'Your session expired. Run `crossly login` again.',
      EXIT.unauthenticated,
      'session_expired',
    );
  }

  const next = await refresh({ apiBase: apiBase(), refreshToken: stored.refreshToken });
  if (!next) {
    // A refresh token can be revoked from the web app; that is a deliberate
    // act by the user and deserves the plain answer rather than a retry loop.
    throw new CliError(
      'Your session was revoked or expired. Run `crossly login` again.',
      EXIT.unauthenticated,
      'session_expired',
    );
  }

  writeAuth({
    ...stored,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken ?? stored.refreshToken,
    expiresAt: next.expiresAt,
  });
  return { token: next.accessToken, source: 'file' };
}

export async function client(): Promise<CrosslyClient> {
  const { token } = await resolveAuth();
  return createClient({
    pat: token,
    baseUrl: apiBase(),
    userAgent: '@crossly/cli',
  });
}
