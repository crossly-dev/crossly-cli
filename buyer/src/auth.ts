/**
 * Where the buyer token lives.
 *
 * ── A FILE, NOT THE OS KEYCHAIN ──────────────────────────────────────
 * Same reasoning as @crossly/cli: every keychain binding is a native module,
 * and a native module in a globally-installed CLI turns `npm i -g` into a
 * compiler error on someone's laptop. A 0600 file in the user's home directory
 * is what gh, aws and stripe ship, and it is the right trade.
 *
 * ── SEPARATE FILE FROM THE SELLER CLI ────────────────────────────────
 * `~/.crossly/auth.json` holds a seller token, this holds a buyer one. Sharing
 * one file would mean `crossly login` and `crossly-buyer login` overwrite each
 * other, and the symptom — every other command 403s until you log in again —
 * would be maddening to diagnose.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, EXIT } from './exit.js';

export const AUTH_PATH = join(homedir(), '.crossly', 'buyer-auth.json');

export interface StoredAuth {
  token: string;
  /** Scopes the token was granted, when the issuer told us. */
  scopes?: string[];
  baseUrl?: string;
  savedAt?: string;
}

export function save(auth: StoredAuth): void {
  mkdirSync(dirname(AUTH_PATH), { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify({ ...auth, savedAt: new Date().toISOString() }, null, 2));
  // Best-effort: chmod is a no-op on Windows, which is why the file also lives
  // under the user profile rather than anywhere shared.
  try {
    chmodSync(AUTH_PATH, 0o600);
  } catch {
    /* windows */
  }
}

export function load(): StoredAuth | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_PATH, 'utf8')) as StoredAuth;
  } catch {
    return null;
  }
}

export function clear(): boolean {
  if (!existsSync(AUTH_PATH)) return false;
  rmSync(AUTH_PATH);
  return true;
}

/**
 * The token to use, preferring the environment.
 *
 * Env first so CI can inject one without writing a file, and so a shell can
 * override a stale stored token without logging out.
 */
export function resolveToken(): { token: string; baseUrl?: string } {
  const fromEnv = process.env.CROSSLY_BUYER_TOKEN;
  if (fromEnv) return { token: fromEnv, baseUrl: process.env.CROSSLY_API_BASE_URL };

  const stored = load();
  if (stored?.token) {
    return { token: stored.token, baseUrl: process.env.CROSSLY_API_BASE_URL ?? stored.baseUrl };
  }

  // Name the seller token explicitly: someone with CROSSLY_PAT already exported
  // will otherwise assume this CLI should have picked it up.
  const hint = process.env.CROSSLY_PAT
    ? '\n\nNote: CROSSLY_PAT is set, but that is a SELLER token. The buyer API is a ' +
      'separate principal and will reject it — use `crossly` for store commands.'
    : '';

  throw new CliError(
    `Not authenticated. Run \`crossly-buyer login\`, or set CROSSLY_BUYER_TOKEN.${hint}`,
    EXIT.unauthenticated,
  );
}
