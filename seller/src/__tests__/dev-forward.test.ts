/**
 * `crossly dev --forward` target checking.
 *
 * This is the only thing standing between "forward webhooks to my laptop" and
 * "stream this account's orders, buyer names and shipping addresses to a host
 * somebody put on a command line". It runs continuously once started, so a
 * mistake here does not fail once — it exfiltrates until the terminal is
 * closed.
 *
 * The lookalike cases are the point. `127.0.0.1.evil.test` resolves to
 * somebody else's server and passes any check written with `includes` or
 * `startsWith`, which is how this is usually got wrong.
 */
import { describe, it, expect } from 'vitest';
import { checkForwardTarget } from '../commands/dev.js';
import { EXIT } from '../exit.js';

function refusal(url: string, allowRemote = false): { code: number; message: string } | null {
  try {
    checkForwardTarget(url, allowRemote);
    return null;
  } catch (err) {
    const e = err as { code: number; message: string };
    return { code: e.code, message: e.message };
  }
}

describe('local targets are allowed', () => {
  it.each([
    'http://localhost:3000/hook',
    'http://127.0.0.1:3000/hook',
    'http://127.0.0.1/hook',
    'https://localhost:8443/hook',
    'http://[::1]:3000/hook',
  ])('%s', (url) => {
    expect(refusal(url)).toBeNull();
  });
});

describe('remote targets are refused', () => {
  it('refuses an ordinary remote host', () => {
    const r = refusal('http://evil.test/hook');
    expect(r?.code).toBe(EXIT.usage);
    expect(r?.message).toContain('evil.test');
  });

  it('refuses a host that merely CONTAINS 127.0.0.1', () => {
    // The classic bypass. Resolves to whatever evil.test wants.
    expect(refusal('http://127.0.0.1.evil.test/hook')).not.toBeNull();
  });

  it('refuses a host that merely ENDS WITH localhost', () => {
    expect(refusal('http://notlocalhost/hook')).not.toBeNull();
  });

  it('refuses a subdomain of localhost', () => {
    expect(refusal('http://localhost.evil.test/hook')).not.toBeNull();
  });

  it('refuses userinfo smuggling', () => {
    // `http://localhost@evil.test/` has hostname evil.test — the part before
    // the @ is credentials, not a host, and reading it as one is a real bug
    // pattern in hand-rolled URL checks.
    expect(refusal('http://localhost@evil.test/hook')).not.toBeNull();
  });
});

describe('the escape hatch', () => {
  it('allows a remote target only when explicitly opted in', () => {
    expect(refusal('http://staging.internal/hook', true)).toBeNull();
  });

  it('names the override in the refusal, so it is discoverable', () => {
    expect(refusal('http://evil.test/hook')?.message).toContain('CROSSLY_DEV_ALLOW_REMOTE');
  });
});

describe('malformed input', () => {
  it('refuses what is not a URL at all', () => {
    expect(refusal('localhost:3000')?.code).toBe(EXIT.usage);
    expect(refusal('')?.code).toBe(EXIT.usage);
  });
});
