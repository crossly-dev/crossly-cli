/**
 * The generated command tree must cover the registry — all of it.
 *
 * ── WHY THIS IS THE LOAD-BEARING TEST ────────────────────────────────
 * The CLI's whole claim is that every endpoint is reachable and that adding an
 * MCP tool gives you a command for free. Both are only true while generation
 * has actually been re-run. A stale `src/generated/commands.ts` fails in the
 * worst way available: the CLI works, help looks complete, and the four
 * commands somebody added last week simply do not exist — with no error
 * anywhere, because nothing knows they should.
 *
 * So coverage is asserted against the REAL registry rather than against the
 * generator's own output. A generator bug that silently skipped a file would
 * otherwise agree with itself.
 */
import { describe, it, expect } from 'vitest';
import { ALL_TOOLS } from '@crossly/mcp/registry';
import { GENERATED_COMMANDS, COMMAND_INDEX, TOOL_INDEX } from '../generated/commands.js';

/**
 * Tools deliberately absent from the command tree.
 *
 * Empty, and that is the point — an entry here is a decision that an endpoint
 * is unreachable from the CLI, which needs a reason somebody signed off on.
 */
const EXCLUDED: Record<string, string> = {};

describe('command coverage', () => {
  it('maps every tool in the registry', () => {
    const mapped = new Set(GENERATED_COMMANDS.map((c) => c.tool));
    const missing = ALL_TOOLS.map((t) => t.name).filter(
      (n) => !mapped.has(n) && !(n in EXCLUDED),
    );

    expect(
      missing,
      missing.length
        ? `${missing.length} tool(s) have no command — run \`pnpm generate\` in packages/cli:\n  ${missing.join('\n  ')}`
        : '',
    ).toEqual([]);
  });

  it('maps no tool that the registry does not have', () => {
    // The inverse failure: a command pointing at a tool that was renamed or
    // deleted. It would dispatch to nothing and only surface when run.
    const known = new Set(ALL_TOOLS.map((t) => t.name));
    const orphans = GENERATED_COMMANDS.filter((c) => !known.has(c.tool)).map((c) => c.tool);
    expect(orphans).toEqual([]);
  });

  it('gives every command a unique path', () => {
    // Two tools deriving to one path would leave one permanently unreachable.
    // The generator refuses to emit this, so a failure here means the file was
    // hand-edited.
    const paths = GENERATED_COMMANDS.map((c) => `${c.group} ${c.verb}`);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('keeps both indexes in step with the list', () => {
    expect(COMMAND_INDEX.size).toBe(GENERATED_COMMANDS.length);
    expect(TOOL_INDEX.size).toBe(GENERATED_COMMANDS.length);
  });
});

describe('command shape', () => {
  it('uses only characters that are typeable without quoting', () => {
    // A verb containing a space, a slash or a shell metacharacter would need
    // quoting at a prompt, which no CLI should ask for.
    for (const c of GENERATED_COMMANDS) {
      expect(c.group, `group "${c.group}"`).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(c.verb, `verb "${c.group} ${c.verb}"`).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('never produces an empty verb', () => {
    for (const c of GENERATED_COMMANDS) {
      expect(c.verb.length, `${c.tool} derived an empty verb`).toBeGreaterThan(0);
    }
  });
});

describe('every tool is callable as described', () => {
  it('declares an object input schema', () => {
    // The flag parser reads `properties` off this. A tool without one would
    // reject every flag as unknown.
    for (const t of ALL_TOOLS) {
      expect(t.inputSchema?.type, `${t.name}`).toBe('object');
    }
  });

  it('only marks required flags that actually exist', () => {
    // A `required` naming a property that is not declared is unsatisfiable:
    // the parser would demand a flag whose name it will then reject.
    for (const t of ALL_TOOLS) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const req of t.inputSchema.required ?? []) {
        expect(props, `${t.name} requires "${req}" but does not declare it`).toContain(req);
      }
    }
  });

  it('describes itself — help text is generated from this', () => {
    for (const t of ALL_TOOLS) {
      expect(t.description?.length ?? 0, `${t.name} has no description`).toBeGreaterThan(10);
    }
  });
});
