/**
 * Help text, built from the registry.
 *
 * Nothing here is hand-written per command. A `--help` that was maintained
 * separately from the tool it documents drifts the first time a flag changes,
 * and a CLI whose help is wrong is worse than one with none — the user acts on
 * it.
 */
import { GENERATED_COMMANDS } from './generated/commands.js';
import { allTools, findTool } from './commands/run-tool.js';
import { GLOBAL_FLAGS } from './args.js';

const GLOBAL_HELP = `crossly — Crossly from the terminal

USAGE
  crossly <group> <verb> [flags]
  crossly api <tool> [flags]        run any endpoint by its tool name
  crossly <group> --help            what a group can do

AUTH
  crossly login [--device]          browser sign-in; --device for SSH/headless
  crossly logout
  crossly whoami

OUTPUT
  --json                            JSON (the default when piped)
  --ndjson                          one JSON object per line, for streaming
  --dry-run                         validate and show what would be sent
  --idempotency-key <key>           safe retries on writes

EXIT CODES
  0 ok   1 failed   2 usage   4 not signed in   5 missing scope
`;

export function globalHelp(): string {
  const groups = [...new Set(GENERATED_COMMANDS.map((c) => c.group))].sort();
  const width = Math.max(...groups.map((g) => g.length));
  const lines = groups.map((g) => {
    const n = GENERATED_COMMANDS.filter((c) => c.group === g).length;
    return `  ${g.padEnd(width)}  ${n} command${n === 1 ? '' : 's'}`;
  });
  return `${GLOBAL_HELP}\nGROUPS (${groups.length}, ${GENERATED_COMMANDS.length} commands)\n${lines.join('\n')}\n`;
}

/** First sentence only — a group listing wants a line per verb, not a paragraph. */
function summarize(description: string): string {
  const firstSentence = description.split(/(?<=\.)\s/)[0] ?? description;
  return firstSentence.length > 88 ? `${firstSentence.slice(0, 87)}…` : firstSentence;
}

export function groupHelp(group: string): string {
  const cmds = GENERATED_COMMANDS.filter((c) => c.group === group);
  if (cmds.length === 0) return `Unknown group "${group}". Run \`crossly --help\`.`;

  const width = Math.max(...cmds.map((c) => c.verb.length));
  const lines = cmds.map((c) => {
    const tool = findTool(c.tool);
    return `  ${c.verb.padEnd(width)}  ${tool ? summarize(tool.description) : ''}`.trimEnd();
  });
  return `crossly ${group} — ${cmds.length} commands\n\n${lines.join('\n')}\n\nRun \`crossly ${group} <verb> --help\` for flags.\n`;
}

export function commandHelp(group: string, verb: string, toolName: string): string {
  const tool = findTool(toolName);
  if (!tool) return `Unknown command.`;

  const props = (tool.inputSchema.properties ?? {}) as Record<
    string,
    { type?: string; description?: string; enum?: unknown[]; default?: unknown }
  >;
  const required = new Set(tool.inputSchema.required ?? []);

  const names = Object.keys(props).sort();
  const flagLines = names.map((name) => {
    const p = props[name]!;
    // Flags are typed in kebab-case even though the schema is camelCase; the
    // parser accepts both, and this shows the one people actually type.
    const flag = `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const type = p.enum ? p.enum.join('|') : (p.type ?? 'string');
    const tag = required.has(name) ? ' (required)' : '';
    const dflt = p.default !== undefined ? ` [default: ${String(p.default)}]` : '';
    return `  ${flag} <${type}>${tag}${dflt}\n      ${p.description ?? ''}`.trimEnd();
  });

  return [
    `crossly ${group} ${verb}`,
    '',
    tool.description,
    '',
    flagLines.length ? `FLAGS\n${flagLines.join('\n')}` : 'No flags.',
    '',
    `GLOBAL\n  ${[...GLOBAL_FLAGS].map((f) => `--${f}`).join(', ')}`,
    '',
    `Equivalent: crossly api ${tool.name}`,
    '',
  ].join('\n');
}

/** `crossly api --list` — the agent-facing index of everything callable. */
export function toolList(asJson: boolean): string {
  const tools = allTools();
  if (asJson) {
    return `${JSON.stringify(
      tools.map((t) => ({
        tool: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      null,
      2,
    )}\n`;
  }
  const width = Math.max(...tools.map((t) => t.name.length));
  return `${tools
    .map((t) => `${t.name.padEnd(width)}  ${summarize(t.description)}`)
    .join('\n')}\n`;
}
