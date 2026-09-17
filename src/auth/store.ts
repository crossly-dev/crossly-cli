/**
 * Where the token lives.
 *
 * ── WHY A FILE AND NOT THE OS KEYCHAIN ───────────────────────────────
 * The keychain is the better place for a secret and this deliberately does not
 * use it. Every Node keychain binding is a NATIVE module, and a native module
 * in a globally-installed CLI is the single most common reason `npm i -g`
 * fails: no prebuild for that Node/OS/arch, no compiler on the machine, and a
 * developer who wanted a CLI now has a node-gyp error instead.
 *
 * `gh`, `aws` and `stripe` all default to a mode-0600 file for the same
 * reason. This does what they do, and says so rather than implying a stronger
 * guarantee than it offers.
 *
 * What that means concretely: the token is readable by anything running as
 * this user. On a shared machine, or one where you would not paste a password,
 * prefer `CROSSLY_PAT` from your own secret manager — it is checked first and
 * never written to disk.
 *
 * ── PRECEDENCE ───────────────────────────────────────────────────────
 *   1. CROSSLY_PAT            env — CI, containers, secret managers
 *   2. ~/.crossly/auth.json   written by `crossly login`
 *
 * Env wins so that a CI job cannot accidentally pick up a developer token that
 * happens to be in the image.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface StoredAuth {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent for a PAT, which does not expire on a schedule. */
  expiresAt?: number;
  /** For `crossly whoami` to answer without a round trip. */
  account?: { userId?: string; email?: string };
  /** Which API this token is for — a staging token must not be sent to prod. */
  baseUrl: string;
}

export function configDir(): string {
  // Honoured so a test, a container, or a second account can be isolated
  // without touching the developer's real session.
  const override = process.env.CROSSLY_CONFIG_DIR;
  if (override) return override;
  return join(homedir(), '.crossly');
}

export function authPath(): string {
  return join(configDir(), 'auth.json');
}

/** The env token, if one is set. Never written, never refreshed. */
export function envToken(): string | null {
  const t = process.env.CROSSLY_PAT?.trim();
  return t ? t : null;
}

export function readAuth(): StoredAuth | null {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredAuth;
    if (!parsed.accessToken) return null;
    return parsed;
  } catch {
    // A corrupt file is treated as "not logged in" rather than a crash: the
    // remedy is the same (`crossly login`) and a parse error at startup would
    // block every command including the one that fixes it.
    return null;
  }
}

export function writeAuth(auth: StoredAuth): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = authPath();

  // Write, THEN tighten. Creating at 0600 via the mode option is not portable
  // (it is masked by umask on some platforms and ignored on Windows), so the
  // explicit chmod is what actually makes the guarantee on POSIX.
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
  try {
    chmodSync(path, 0o600);
    chmodSync(dirname(path), 0o700);
  } catch {
    // Windows has no POSIX mode. Not fatal, and not silently pretended away:
    // `crossly whoami` reports where the token is stored so the user can see
    // what they are trusting.
  }
}

export function clearAuth(): void {
  rmSync(authPath(), { force: true });
}
