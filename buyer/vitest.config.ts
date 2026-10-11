import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The CLI's tests read the buyer MCP registry (and the SDK under it) from
 * SOURCE, not from the sibling packages' built `dist/`.
 *
 * Why: `@crossly/buyer-mcp`'s exports map points at `dist/`, which is
 * gitignored and only as fresh as the last `pnpm build`. Round 6 added eight
 * vault tools to the registry and the CLI's command map in the same change;
 * against a `dist/` built before it, `commands.ts` throws ("maps
 * get_my_vault_worth, which is not in the registry") and every test fails
 * until someone remembers a manual rebuild. `pnpm test` builds nothing, so
 * the tests now follow the source the way the rest of the workspace does.
 *
 * All three entry points are aliased together on purpose: `index.ts` calls
 * `configureClient` from `@crossly/buyer-mcp/api`, and the tools import that
 * same module relatively. Half source, half dist would be two module
 * instances, and the client the CLI configures would never reach the tools
 * (registry-source.test.ts pins this).
 *
 * Exact-match patterns, so `@crossly/buyer-mcp` never swallows its subpaths.
 * Each alias applies only when the sibling source exists: a standalone copy
 * of this package (the public mirror) resolves the published packages as
 * usual. The shipped binary is unchanged: `tsc` still compiles against the
 * packages' types, and `pnpm -r build` builds them first (topological order).
 */
const here = dirname(fileURLToPath(import.meta.url));

const SOURCES: Array<[RegExp, string]> = [
  [/^@crossly\/buyer-mcp\/registry$/, '../buyer-mcp/src/registry.ts'],
  [/^@crossly\/buyer-mcp\/api$/, '../buyer-mcp/src/api.ts'],
  [/^@crossly\/buyer-sdk$/, '../buyer-sdk/src/index.ts'],
];

const alias = SOURCES.map(([find, rel]) => ({ find, replacement: resolve(here, rel) })).filter((a) => existsSync(a.replacement));

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
