/**
 * The scopes the CLI asks for.
 *
 * Everything it can do, because a token scoped narrower would make most of the
 * 287 commands fail with `insufficient_scope` — and the remedy for that is
 * another login, which is worse for the user than one honest consent screen
 * that lists what the tool does.
 *
 * Someone who wants a narrower credential still has the better option: mint a
 * PAT with exactly the scopes they want and export `CROSSLY_PAT`, which takes
 * precedence over anything `crossly login` stores.
 *
 * Shared with `crossly mcp install`, which mints a PAT for an AI client. The
 * two must not drift: an MCP server that can do less than the CLI is a
 * difference nobody would predict from the outside.
 */
export const CLI_SCOPES = [
  'inventory:read', 'inventory:write',
  'listings:read', 'listings:write',
  'orders:read', 'orders:write',
  'sales:read', 'sales:write',
  'accounts:read', 'accounts:write',
  'analytics:read',
  'inbox:read', 'inbox:write',
  'automation:read', 'automation:write',
  'customers:read', 'customers:write',
  'webhooks:read', 'webhooks:write',
  'integrations:read', 'integrations:write',
  'activity:read',
  'catalog:read',
  'tax:read', 'tax:write',
];
