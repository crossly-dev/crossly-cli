/**
 * `--help` must never touch the network.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────
 * Help was handled per-branch in the workflow dispatcher and two branches were
 * missed, so `crossly inventory export --help` authenticated, called the API
 * and exited 4 — "not signed in" — for someone asking what the command does.
 * The person most likely to type `--help` is the one who has not logged in
 * yet, which makes this the worst possible command to require a session.
 *
 * Asserted by RUNNING the built CLI with no credentials and an unreachable API
 * base. Anything that reaches out fails; anything that only prints passes. A
 * unit test of the dispatcher would not catch a new branch forgetting the
 * check, which is exactly how this happened.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

/** No token, and an API base that cannot resolve. */
const OFFLINE_ENV = {
  ...process.env,
  CROSSLY_PAT: '',
  CROSSLY_CONFIG_DIR: join(__dirname, '__no_such_config__'),
  CROSSLY_API_BASE_URL: 'http://127.0.0.1:1/api',
};

function runHelp(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args, '--help'], {
      env: OFFLINE_ENV,
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('--help works with no credentials and no network', () => {
  it.each([
    ['logs'],
    ['listings', 'publish'],
    ['orders', 'ship'],
    ['dev'],
    ['inventory', 'import'],
    ['inventory', 'export'],
    ['mcp', 'install'],
  ])('crossly %s %s --help', (...args) => {
    const { code, out } = runHelp(args.filter(Boolean));
    expect(code, `exited ${code} — help should never authenticate:\n${out}`).toBe(0);
    expect(out.length).toBeGreaterThan(20);
  });

  it('also works for a generated command', () => {
    const { code } = runHelp(['orders', 'list']);
    expect(code).toBe(0);
  });

  it('and for the global help', () => {
    const { code } = runHelp([]);
    expect(code).toBe(0);
  });
});
