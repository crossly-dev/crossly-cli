# Crossly CLI

Crossly from the terminal: one command for every endpoint, for people and for agents.

Crossly has two APIs with separate keys: the **seller** API runs a store, the **buyer** API is for shoppers. Each has its own package in this repo.

| Folder | Package | For |
|---|---|---|
| [`seller/`](./seller) | `@crossly/cli` | `crossly`: the seller API |
| [`buyer/`](./buyer) | `@crossly/buyer-cli` | `crossly-buyer`: the buyer API |

```bash
npm install @crossly/cli
npm install @crossly/buyer-cli
```

Each folder has its own README with setup and examples. Docs: https://crossly.net/docs

_Synced from the Crossly monorepo at aacda07f. Open issues here; pull requests are welcome but are applied upstream._
