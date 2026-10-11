/**
 * Flag parsing, driven by each tool's JSON Schema.
 *
 * There is no argv library here on purpose. The SDK ships with zero runtime
 * dependencies and a globally-installed CLI is the worst place to inherit a
 * dependency tree — but the real reason is that the schema already says what
 * every flag is and what type it takes, so a general-purpose parser would be
 * given that information and then asked to ignore it.
 *
 * Coercion is schema-driven for the same reason: `--limit 50` has to reach the
 * API as the number 50, and only the schema knows that `limit` is an integer
 * while `sku` that happens to look numeric is a string.
 */
import { usageError } from './exit.js';

export interface ParsedArgs {
  /** Positional words before any flag — the command path. */
  path: string[];
  flags: Record<string, unknown>;
  /** Raw string values, before coercion. Kept for error messages. */
  raw: Record<string, string | boolean>;
}

/** Split argv into a command path and flags. Values may be `--k v` or `--k=v`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const path: string[] = [];
  const raw: Record<string, string | boolean> = {};
  let seenFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (!token.startsWith('-')) {
      // A bare word after a flag is that flag's value, handled below; reaching
      // here means it is part of the command path.
      if (!seenFlag) path.push(token);
      else path.push(token);
      continue;
    }

    seenFlag = true;
    const body = token.replace(/^--?/, '');

    if (body.includes('=')) {
      const idx = body.indexOf('=');
      raw[body.slice(0, idx)] = body.slice(idx + 1);
      continue;
    }

    const next = argv[i + 1];
    // A flag followed by another flag, or by nothing, is a boolean. `--json`
    // and `--dry-run` are the common case and must not swallow the next word.
    if (next === undefined || next.startsWith('-')) {
      raw[body] = true;
      continue;
    }
    raw[body] = next;
    i += 1;
  }

  return { path, flags: {}, raw };
}

type JsonSchemaProp = {
  type?: string;
  items?: { type?: string };
  description?: string;
  enum?: unknown[];
  default?: unknown;
};

function coerce(name: string, value: string | boolean, prop: JsonSchemaProp | undefined): unknown {
  const type = prop?.type;

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw usageError(`--${name} expects true or false, got "${value}".`);
  }

  // A value-taking flag given as a bare switch is a mistake worth naming: the
  // alternative is sending `true` where the API wants a string and getting a
  // validation error that points at the server.
  if (typeof value === 'boolean') {
    throw usageError(`--${name} needs a value.`);
  }

  if (type === 'integer' || type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw usageError(`--${name} expects a number, got "${value}".`);
    if (type === 'integer' && !Number.isInteger(n)) {
      throw usageError(`--${name} expects a whole number, got "${value}".`);
    }
    return n;
  }

  if (type === 'array') {
    // Comma-separated, because `--to poshmark,depop` is what people type.
    const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
    return prop?.items?.type === 'number' || prop?.items?.type === 'integer'
      ? parts.map(Number)
      : parts;
  }

  if (type === 'object') {
    try {
      return JSON.parse(value);
    } catch {
      throw usageError(`--${name} expects JSON, got "${value}".`);
    }
  }

  return value;
}

/**
 * Flags every command accepts; stripped before the schema sees them.
 *
 * `idempotency-key` is deliberately NOT here. It looks global — every write
 * takes one — but it is a real property on each write tool's schema, and
 * listing it here meant `buildArgs` stripped it and the handler never received
 * it. The flag was accepted, reported in --dry-run's echo as absent, and
 * silently did nothing: a retry the user believed was safe re-executed the
 * write. Leaving it to the schema also means a READ command correctly rejects
 * it rather than pretending it means something.
 */
export const GLOBAL_FLAGS = new Set([
  'json',
  'ndjson',
  'help',
  'h',
  'dry-run',
  'quiet',
  'q',
]);

export interface SchemaLike {
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * Turn raw flags into an argument object for a tool.
 *
 * Unknown flags are an ERROR rather than being passed through. A typo in
 * `--platfrom` that reached the API would come back as "no results" — a wrong
 * answer that looks like a right one, which is the failure this whole CLI is
 * meant to avoid.
 */
export function buildArgs(
  raw: Record<string, string | boolean>,
  schema: SchemaLike,
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, JsonSchemaProp>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (GLOBAL_FLAGS.has(key)) continue;

    // Flags are typed in kebab-case; schemas use camelCase.
    const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const prop = props[camel] ?? props[key];
    if (!prop) {
      const known = Object.keys(props).sort();
      throw usageError(
        `Unknown flag --${key}.` +
          (known.length ? `\nThis command accepts: ${known.map((k) => `--${k}`).join(', ')}` : ''),
      );
    }
    out[props[camel] ? camel : key] = coerce(key, value, prop);
  }

  const missing = (schema.required ?? []).filter((r) => out[r] === undefined);
  if (missing.length > 0) {
    throw usageError(`Missing required: ${missing.map((m) => `--${m}`).join(', ')}`);
  }

  return out;
}
