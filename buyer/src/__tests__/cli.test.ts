/**
 * The CLI's contract.
 *
 * Two things get disproportionate attention because they are the bugs that
 * actually shipped in the seller CLI:
 *
 *   1. `--help` hitting the network. Two workflow branches missed the check,
 *      so `inventory export --help` exited 4 for anyone not logged in. Help
 *      must work on a plane.
 *   2. The command map drifting from the registry. A tool with no command is
 *      an endpoint nobody can reach from the CLI, and nothing else notices.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main } from '../index.js';
import { COMMANDS, TOOL_BY_COMMAND, ALL_TOOLS } from '../commands.js';
import { EXIT, exitCodeFor, CliError } from '../exit.js';
import { render } from '../output.js';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
  // Any network call is a test failure by construction.
  vi.stubGlobal('fetch', () => {
    throw new Error('network called');
  });
  delete process.env.CROSSLY_BUYER_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('command map covers the registry', () => {
  it('maps every buyer tool to exactly one command', () => {
    const mapped = new Set(COMMANDS.map((c) => c.tool));
    const missing = ALL_TOOLS.filter((t) => !mapped.has(t.name)).map((t) => t.name);
    expect(missing, `tools with no CLI command: ${missing.join(', ')}`).toEqual([]);
  });

  it('maps nothing that is not in the registry', () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    const extra = COMMANDS.filter((c) => !names.has(c.tool)).map((c) => c.tool);
    expect(extra).toEqual([]);
  });

  it('has no duplicate command paths', () => {
    const paths = COMMANDS.map((c) => `${c.group} ${c.verb}`);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('resolves all 30 buyer tools', () => {
    expect(TOOL_BY_COMMAND.size).toBe(ALL_TOOLS.length);
    expect(ALL_TOOLS.length).toBe(30);
  });
});

describe('--help never needs auth or a network', () => {
  it('prints top-level help with no token', async () => {
    const code = await main([]);
    expect(code).toBe(EXIT.usage);
    expect(out.join('')).toContain('crossly-buyer');
  });

  it.each(COMMANDS.map((c) => [`${c.group} ${c.verb}`]))(
    'prints help for `%s` with no token',
    async (path) => {
      const [group, verb] = path.split(' ');
      const code = await main([group!, verb!, '--help']);
      expect(code).toBe(EXIT.ok);
      expect(out.join('')).toContain(`${group} ${verb}`);
    },
  );
});

describe('usage errors happen before the network', () => {
  it('rejects an unknown command', async () => {
    await expect(main(['cart', 'explode'])).rejects.toMatchObject({ code: EXIT.usage });
  });

  it('rejects an unknown group', async () => {
    await expect(main(['nonsense'])).rejects.toMatchObject({ code: EXIT.usage });
  });

  it('rejects an unknown flag and lists the real ones', async () => {
    try {
      await main(['cart', 'add', '--listingSlug', 'x', '--bogus', '1']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT.usage);
      expect((e as Error).message).toContain('--bogus');
      expect((e as Error).message).toContain('--listingSlug');
    }
  });

  it('names every missing required flag at once', async () => {
    try {
      await main(['offers', 'make']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT.usage);
      expect((e as Error).message).toMatch(/listingSlug/);
    }
  });

  it('rejects a non-numeric value for a numeric flag', async () => {
    try {
      await main(['orders', 'list', '--limit', 'lots']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CliError).code).toBe(EXIT.usage);
    }
  });
});

describe('--dry-run sends nothing', () => {
  it('reports what would be sent without a token', async () => {
    const code = await main([
      'offers', 'make',
      '--listingSlug', 'vintage-levis',
      '--amountCents', '4500',
      '--dry-run', '--json',
    ]);
    expect(code).toBe(EXIT.ok);
    const printed = JSON.parse(out.join(''));
    expect(printed).toMatchObject({
      tool: 'offer_on_listing',
      wouldSend: true,
      args: { listingSlug: 'vintage-levis', amountCents: 4500 },
    });
    // The coercion matters: 4500 not "4500".
    expect(typeof printed.args.amountCents).toBe('number');
  });
});

describe('auth', () => {
  it('exits unauthenticated, not failure, with no token', async () => {
    await expect(main(['cart', 'get'])).rejects.toMatchObject({
      code: EXIT.unauthenticated,
    });
  });

  it('points at the seller CLI when only CROSSLY_PAT is set', async () => {
    process.env.CROSSLY_PAT = 'crossly_pat_test';
    try {
      await main(['cart', 'get']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/SELLER token/);
    } finally {
      delete process.env.CROSSLY_PAT;
    }
  });

  it('refuses to store a seller PAT', async () => {
    // Validating at login rather than at first use: storing it would make
    // every later command fail with an unrelated-looking 403.
    await expect(main(['login', '--token', 'crossly_pat_test'])).rejects.toThrow(
      /seller Personal Access Token/,
    );
  });
});

describe('exit codes distinguish remedies', () => {
  it('401 is unauthenticated', () => {
    expect(exitCodeFor({ status: 401 })).toBe(EXIT.unauthenticated);
  });

  it('403 mentioning a scope is its own code', () => {
    // Re-consent, not re-login. Different action entirely.
    expect(
      exitCodeFor({ status: 403, code: 'insufficient_scope', message: 'needs buyer:cart:read' }),
    ).toBe(EXIT.forbiddenScope);
  });

  it('403 NOT about a scope is a plain failure', () => {
    expect(exitCodeFor({ status: 403, code: 'forbidden', message: 'not your listing' })).toBe(
      EXIT.failure,
    );
  });
});

describe('output', () => {
  it('formats cents columns as money', () => {
    const t = render({ data: [{ id: 'a', amountCents: 4500 }] });
    expect(t).toContain('$45.00');
  });

  it('leaves --json byte-faithful', () => {
    // A script piping to jq is the second-biggest consumer; reshaping breaks
    // it silently.
    const payload = { data: [{ id: 'a', amountCents: 4500 }], meta: { total: 1 } };
    expect(JSON.parse(render(payload, { json: true }))).toEqual(payload);
  });

  it('renders a single object as key/value, not a sideways table', () => {
    const r = render({ data: { name: 'Sam', bucksBalanceCents: 250 } });
    expect(r).toContain('name');
    expect(r).toContain('$2.50');
    expect(r.split('\n').length).toBeGreaterThan(1);
  });

  it('emits one JSON object per line for --ndjson', () => {
    const r = render({ data: [{ a: 1 }, { a: 2 }] }, { ndjson: true });
    expect(r.split('\n').map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
