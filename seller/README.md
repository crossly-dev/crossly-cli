# `@crossly/cli`

Crossly from the terminal. 287 commands, one for every endpoint.

> **Not on npm yet.** `@crossly/cli` is unreleased — the install command below
> will 404 until the first publish. To try it now, clone this repo and build from
> source. Star or watch to hear when it lands.


```bash
npm i -g @crossly/cli
crossly login
crossly orders list --status pending
```

## Two ways to reach the same thing

```bash
crossly orders submit-tracking --id <uuid> --carrier usps --tracking-number 92055
crossly api submit_tracking   --id <uuid> --carrier usps --tracking-number 92055
```

The first is for people. The second uses the registry's own tool names — stable
even if a verb is renamed for readability, which is what a script or an agent
wants. `crossly api --list --json` prints every tool with its JSON Schema, so an
agent can discover the surface without being told about it.

## Where the commands come from

Nobody wrote 287 commands. They are generated from
`packages/mcp/src/registry.ts` — the same array the MCP server serves — so
help text, flags and validation are read from the tool being run and cannot
disagree with it.

The group comes from the file (`tools/orders.ts` → `crossly orders`) and the
verb from the name with the noun removed (`get_order_shipments` → `shipments`).
Deriving from the name alone would only work for about half the registry;
deriving from the file works because the registry is already grouped by domain.

**Add an MCP tool, get a command.** A test asserts every tool has one, so a
stale generated file fails the build instead of quietly shipping a CLI that is
missing last week's endpoints.

```bash
pnpm generate   # after adding or renaming a tool
```

## The commands worth knowing

Most of the 287 are one API call. These are the ones that are not:

```bash
crossly logs -f                              # every platform call, live
crossly logs -f --platform depop --status failure

crossly listings publish <itemId> --to poshmark,depop
# crossposting is async — this WAITS and reports per platform.
# exits 1 if any failed or is still pending.

crossly orders ship <orderId>                # rates, buys nothing
crossly orders ship <orderId> --yes          # buys cheapest, submits tracking

crossly inventory import items.csv           # validates only
crossly inventory import items.csv --yes     # writes
crossly inventory export items.csv

crossly dev --forward http://localhost:3000/hook
crossly mcp install                          # wire Crossly into Claude/Cursor
```

**`--yes` gates anything that spends money or writes in bulk.** `orders ship`
without it prints rates and buys nothing; `inventory import` without it
validates and writes nothing. A command that silently bought postage because
you forgot a flag would be the worst bug in here.

**`crossly dev` needs no tunnel.** It holds an outbound connection and re-POSTs
each event to your machine, so nothing here has to be reachable from the
internet — no ngrok, no public URL, no firewall hole. `--forward` refuses a
non-localhost target unless you set `CROSSLY_DEV_ALLOW_REMOTE=1`, because those
payloads carry order totals, buyer names and shipping addresses.

## Auth

```bash
crossly login             # browser, PKCE, loopback
crossly login --device    # short code — SSH, containers, agent sandboxes
crossly whoami
crossly logout
```

The device flow is chosen automatically when there is no browser to open
(`SSH_CONNECTION`, no `DISPLAY`, `CI`). Getting that wrong is invisible to the
user — they just watch a browser never appear — so it is detected rather than
left as a flag to discover.

`CROSSLY_PAT` takes precedence over a stored session, so CI uses a token from
its own secret store and never picks up a developer's.

**The token is a mode-0600 file at `~/.crossly/auth.json`, not the OS
keychain.** Every Node keychain binding is a native module, and a native module
in a globally-installed CLI is the most common reason `npm i -g` fails. `gh`,
`aws` and `stripe` make the same trade. It is readable by anything running as
you — on a shared machine, prefer `CROSSLY_PAT` from your own secret manager.

## For agents

- `--json` everywhere; `--ndjson` on lists for streaming
- errors go to **stderr** as `{error:{code,message,correlationId}}` when
  `--json` is set, so a caller parses one shape whether or not it worked
- `--dry-run` validates and shows what would be sent, without a request
- `--idempotency-key <key>` on writes — the server replays the first response
  for 24h
- unknown flags are an **error**, never ignored: `--platfrom depop` silently
  dropped would return "no results", a wrong answer that looks like a right one

```
0  ok
1  the request failed
2  usage — nothing was sent
4  not signed in            → crossly login
5  token lacks the scope    → crossly login again, or mint a PAT with it
```

4 and 5 are separate because the remedy differs. An agent that conflates them
retries the same login forever.

## The welcome screen

Bare `crossly` spins a wireframe parcel, then prints the command list. It runs
**only** there — never on `--help`, never when output is piped, never in CI,
never on a terminal too narrow to hold it. An animation that delayed
`crossly orders list` would be the thing people write scripts to avoid.

`CROSSLY_NO_BANNER=1` turns it off. `NO_COLOR` drops the colour but keeps the
drawing.

## Output

`table` when stdout is a terminal, `json` when piped. stdout is only ever the
result; progress and warnings go to stderr, so `| jq` always works.
