# @crossly/buyer-cli

Your Crossly shopping, from the terminal.

> **Not on npm yet.** `@crossly/buyer-cli` is unreleased — the install command below
> will 404 until the first publish. To try it now, clone this repo and build from
> source. Star or watch to hear when it lands.

```bash
npm i -g @crossly/buyer-cli
crossly-buyer login --token crossly_oat_...
crossly-buyer cart get
```

## Two binaries, because two APIs

| | |
|---|---|
| `crossly` ([@crossly/cli](https://github.com/crossly-dev/crossly-cli)) | a seller's **store** — 287 commands |
| `crossly-buyer` (this) | a person's **own shopping** — 30 commands |

Different credentials, so different binaries rather than one with a `--buyer` flag. If only `CROSSLY_PAT` is set, this CLI says so and points you at the other one instead of failing with an opaque 403.

## Commands

```
profile    get
orders     list
cashback   list
cart       get  add  remove  quote
wishlists  list  items  create  add
activity   report  list  preferences
offers     make
agent      list  start  get  delete  say  react  act
vault      worth  holdings  history  watchlist  exits  exit  indexes  index
```

Every command takes `--help`, and **`--help` never touches the network or needs a token** — it works on a plane.

```bash
crossly-buyer offers make --help
crossly-buyer offers make --listingSlug vintage-levis-501 --amountCents 4500
```

## Nothing here spends money

`cart quote` prices a basket. `offers make` proposes a number. No command completes a purchase — paying happens on Crossly, with you present.

## For scripts and agents

`--json` on everything, byte-faithful to what the API returned. `--ndjson` on lists, one object per line. `--dry-run` prints what would be sent and sends nothing.

Exit codes distinguish **remedies**, which is the point:

| code | meaning | what to do |
|---|---|---|
| `0` | ok | |
| `1` | the API said no, or the network failed | read the message |
| `2` | you typed something wrong | nothing was sent |
| `4` | not authenticated | `crossly-buyer login` |
| `5` | authenticated, but missing a scope | re-consent — **not** re-login |

Code `5` exists because "your token expired" and "you were never granted `buyer:cashback:read`" need different fixes, and a wrapper that collapses them will guess wrong on the scope case.

## Money renders as money

Columns ending in `Cents` are formatted as `$45.00` in table output. `--json` leaves the raw integer alone — a script piping to `jq` is the second-biggest consumer of this tool, and reshaping "helpfully" breaks it silently.

## Auth

```bash
crossly-buyer login --token crossly_oat_...   # stored 0600 at ~/.crossly/buyer-auth.json
crossly-buyer whoami
crossly-buyer logout
```

`CROSSLY_BUYER_TOKEN` in the environment takes precedence, so CI needs no file and a shell can override a stale token without logging out.

Stored separately from the seller CLI's `~/.crossly/auth.json` on purpose — sharing one file would mean `crossly login` and `crossly-buyer login` silently overwrite each other.

A seller PAT is refused **at login**, not at first use. Storing it would make every later command fail with an unrelated-looking 403.

## Also available

- [`@crossly/buyer-sdk`](https://github.com/crossly-dev/crossly-sdk/tree/main/buyer) — TypeScript client
- [`@crossly/buyer-mcp`](https://github.com/crossly-dev/crossly-mcp/tree/main/buyer) — the same surface as MCP tools

## Building from source

The command tree is generated from the [`@crossly/buyer-mcp`](https://github.com/crossly-dev/crossly-mcp/tree/main/buyer) tool registry, so a tool added there is a command here with no second list (a test fails if the map and the registry drift).

In the Crossly monorepo:

```bash
pnpm --filter @crossly/buyer-cli test       # no build needed: the tests read buyer-mcp and buyer-sdk from source
pnpm --filter @crossly/buyer-cli build:deps # builds buyer-sdk, then buyer-mcp (what the binary imports at run time)
pnpm --filter @crossly/buyer-cli build
```

`pnpm -r build` does the same in dependency order.

## License

MIT
