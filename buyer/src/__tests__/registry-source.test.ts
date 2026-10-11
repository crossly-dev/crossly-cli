/**
 * The CLI sees the buyer MCP registry as it is in source, with no manual
 * rebuild of `@crossly/buyer-mcp` first (vitest.config.ts aliases the
 * package entry points to the sibling source).
 *
 * Pinned because the round-6 vault tools were invisible to the CLI's tests
 * until someone rebuilt buyer-mcp's gitignored dist/, and because the
 * aliases only work if the registry, the api facade and the SDK all come
 * from ONE module instance: the client the CLI configures must be the one
 * the tools call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_TOOLS as viaPackage } from '@crossly/buyer-mcp/registry';
import * as apiViaPackage from '@crossly/buyer-mcp/api';
import { createBuyerClient } from '@crossly/buyer-sdk';
import { ALL_TOOLS as viaSource } from '../../../buyer-mcp/src/registry.js';
import * as apiViaSource from '../../../buyer-mcp/src/api.js';
import { vaultTools } from '../../../buyer-mcp/src/tools/vault.js';
import { COMMANDS, TOOL_BY_COMMAND } from '../commands.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the registry comes from source', () => {
  it('is the very same array the buyer-mcp source exports', () => {
    expect(viaPackage).toBe(viaSource);
  });

  it('includes every vault tool, each reachable as a CLI command', () => {
    expect(vaultTools.length).toBeGreaterThan(0);
    const names = new Set(viaPackage.map((t) => t.name));
    for (const t of vaultTools) expect(names.has(t.name), `${t.name} missing from the registry the CLI reads`).toBe(true);
    const mapped = new Set(COMMANDS.map((c) => c.tool));
    for (const t of vaultTools) expect(mapped.has(t.name), `${t.name} has no CLI command`).toBe(true);
    const vaultNames = new Set(vaultTools.map((t) => t.name));
    expect([...TOOL_BY_COMMAND.values()].filter((t) => vaultNames.has(t.name)).length).toBe(vaultTools.length);
  });

  it('uses one api facade module, so the client the CLI configures is the one the tools call', async () => {
    expect(apiViaPackage.configureClient).toBe(apiViaSource.configureClient);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ valueCents: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    apiViaPackage.configureClient(createBuyerClient({ token: 'crossly_oat_test', baseUrl: 'https://api.example.test' }));
    const worth = TOOL_BY_COMMAND.get('vault worth');
    expect(worth?.name).toBe('get_my_vault_worth');
    await worth!.handler({});
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('https://api.example.test');
    expect(calls[0]).toContain('/v1/buyer/vault-markets/worth');
  });
});
