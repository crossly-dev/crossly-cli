#!/usr/bin/env node
/**
 * Generate the CLI command tree from the MCP tool registry.
 *
 * ── WHY GENERATE AT ALL ──────────────────────────────────────────────
 * There are 287 endpoints. Hand-writing a command per endpoint is not the hard
 * part — keeping 287 of them in step with an API that gains routes weekly is,
 * and every surface that drifts does so silently. `packages/mcp/src/registry.ts`
 * already carries a name, a human description and a JSON Schema for every one
 * of them, so the command tree is derived from it rather than transcribed.
 *
 * Parity stops being a discipline: add an MCP tool, get a command.
 *
 * ── WHY FILE + NAME, NOT NAME ALONE ──────────────────────────────────
 * Deriving `list_orders` → `orders list` from the NAME works for about half
 * the registry (`list_*` 58, `get_*` 46, `update_*` 15, `create_*` 12,
 * `delete_*` 12, `search_*` 7 — 150 of 287). The rest are noun-first
 * (`orders_bulk_export`), domain-prefixed (`imap_test`, `ai_enhance_listing`)
 * or irregular (`extension_online`, `oauth_init_url`).
 *
 * But the registry is ALREADY grouped by domain, one file per noun. So the
 * file gives the group and the name gives the verb, and the irregular names
 * stop being irregular — `submit_tracking` in `orders.ts` is plainly
 * `crossly orders submit-tracking`.
 *
 * ── WHY OUTPUT IS COMMITTED ──────────────────────────────────────────
 * `src/generated/commands.ts` is written into the repo, not produced at
 * install time. A generated tree that only exists after a build step is one
 * nobody can review, and a diff showing "47 new commands appeared" is exactly
 * the review that should happen when someone adds 47 endpoints.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..');
const TOOLS_DIR = join(CLI, '..', 'mcp', 'src', 'tools');
const OUT = join(CLI, 'src', 'generated', 'commands.ts');

/**
 * Groups whose filename is not the word a person would type.
 *
 * Kept deliberately short. A long list here means the registry's own file
 * names have stopped describing their contents, and the fix belongs there.
 */
const GROUP_ALIASES = {
  // `account` (your own) and `accounts` (connected marketplaces) are one
  // letter apart and mean different things — a genuine trap at a prompt, where
  // there is no docblock to disambiguate. The plural one is renamed for what
  // it actually holds: connect_platform, disconnect_platform, platform limits.
  accounts: 'platforms',
  action_log: 'logs',
  comp_watchlists: 'watchlists',
  connected_apps: 'apps',
  saved_views: 'views',
  'catalog-lookup': 'catalog',
  'policy-presets': 'policies',
  variation_groups: 'variations',
  pat: 'tokens',
};

/**
 * Verbs the derivation gets wrong, by tool name.
 *
 * Each entry is a judgement that the mechanical answer reads badly to a human,
 * not a gap in the rule.
 */
const VERB_OVERRIDES = {
  get_me: 'me',
  extension_online: 'extension-status',
  oauth_init_url: 'oauth-url',
  logout_all_sessions: 'logout-all',
  revoke_all_auth_sessions: 'revoke-all',

  // In listings.ts, `list_` abbreviates LISTING — it is the noun, not the verb
  // "list". The rule cannot know that (`list_listings` genuinely does start
  // with the verb), and guessing from what follows would be a heuristic that
  // breaks the next time someone adds `list_something`. Eight explicit lines
  // beat a clever rule nobody can predict.
  list_bulk_relist: 'bulk-relist',
  list_bulk_crosspost: 'bulk-crosspost',
  list_bulk_delist: 'bulk-delist',
  list_bulk_delete: 'bulk-delete',
  list_bulk_hard_delete: 'bulk-hard-delete',
  list_bulk_update: 'bulk-update',
  list_bulk_check_status: 'bulk-check-status',
  list_bulk_delist_preview: 'bulk-delist-preview',
};

/**
 * Words that are the NOUN and so add nothing to the verb.
 *
 * Drawn from the file basename AND the aliased group, each split on its
 * separator, each in both numbers. Both halves are needed: `accounts.ts` is
 * aliased to `platforms`, so `connect_platform` only loses its noun if the
 * ALIAS is considered — without it the command is `platforms connect-platform`.
 * And `action_log.ts` only strips if the basename is SPLIT, because no single
 * part of `list_action_log` equals `action_log`.
 */
function nounWords(base, group) {
  const words = new Set();
  for (const w of [...base.split(/[_-]/), ...group.split(/[_-]/)]) {
    if (!w) continue;
    words.add(w);
    words.add(`${w}s`);
    words.add(w.replace(/s$/, ''));
  }
  return words;
}

function deriveVerb(toolName, base, group) {
  if (VERB_OVERRIDES[toolName]) return VERB_OVERRIDES[toolName];

  const parts = toolName.split('_');
  const nouns = nounWords(base, group);
  const kept = parts.filter((p) => !nouns.has(p));

  // Everything was the noun (`list_orders` in orders.ts → nothing left but
  // `list`). If stripping consumed the whole name, keep the original: a
  // command called "" is worse than a slightly redundant one.
  let verb = kept.length > 0 ? kept : parts;

  // Drop a leading `get` when a noun follows it: `get_order_shipments` in
  // orders.ts derives to `get-shipments`, and `crossly orders shipments` is
  // the same command without the stutter. A BARE `get` stays — that is the
  // fetch-one verb and removing it would leave no command at all.
  if (verb.length > 1 && verb[0] === 'get') verb = verb.slice(1);

  return verb.join('-');
}

/** Extract tool metadata without executing the module. */
function parseToolFile(file) {
  const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
  const out = [];
  // Tools are declared as object literals with `name:` then `description:`.
  // A regex is enough and keeps this script dependency-free; the guard test
  // compares the result against the REAL registry, so a parse that silently
  // missed a tool fails the build rather than shipping a smaller CLI.
  const re = /name:\s*'([a-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts') && f !== 'types.ts');

const commands = [];
const seen = new Map();

for (const file of files) {
  const base = file.replace(/\.ts$/, '');
  const group = GROUP_ALIASES[base] ?? base.replace(/_/g, '-');
  for (const tool of parseToolFile(file)) {
    const verb = deriveVerb(tool, base, group);
    const path = `${group} ${verb}`;
    if (seen.has(path)) {
      // Two tools deriving to one command would make one unreachable. Fail
      // loudly at build time rather than shipping a CLI that silently cannot
      // call an endpoint.
      console.error(
        `\ncollision: "${path}" from both ${seen.get(path)} and ${tool}.\n` +
          `Add a VERB_OVERRIDES entry in scripts/generate-commands.mjs.\n`,
      );
      process.exit(1);
    }
    seen.set(path, tool);
    commands.push({ group, verb, tool });
  }
}

commands.sort((a, b) => (a.group + a.verb).localeCompare(b.group + b.verb));

const body = `/**
 * GENERATED by scripts/generate-commands.mjs — do not edit.
 *
 * ${commands.length} commands across ${new Set(commands.map((c) => c.group)).size} groups,
 * derived from the MCP tool registry. Run \`pnpm generate\` after changing it.
 *
 * Only the MAPPING lives here. Descriptions, flags and validation are read
 * from the registry at runtime, so help text can never disagree with the tool
 * it describes.
 */

export interface GeneratedCommand {
  /** Command group — the first word after \`crossly\`. */
  group: string;
  /** Verb within the group. */
  verb: string;
  /** The MCP tool this runs. Also usable directly: \`crossly api <tool>\`. */
  tool: string;
}

export const GENERATED_COMMANDS: GeneratedCommand[] = ${JSON.stringify(commands, null, 2)};

/** Lookup by \`"group verb"\`. */
export const COMMAND_INDEX: ReadonlyMap<string, GeneratedCommand> = new Map(
  GENERATED_COMMANDS.map((c) => [\`\${c.group} \${c.verb}\`, c]),
);

/** Lookup by MCP tool name — the \`crossly api\` path. */
export const TOOL_INDEX: ReadonlyMap<string, GeneratedCommand> = new Map(
  GENERATED_COMMANDS.map((c) => [c.tool, c]),
);
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, 'utf8');

const groups = new Set(commands.map((c) => c.group));
console.log(`generated ${commands.length} commands across ${groups.size} groups → src/generated/commands.ts`);
