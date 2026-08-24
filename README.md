# peakwagyu skills

Agent skills for operating the Peak Wagyu Shopify store. Works with [Claude Code](https://claude.com/claude-code) and any agent that reads `SKILL.md`.

## Skills

| Skill | What it does |
|---|---|
| [`shopify-store-ops`](skills/shopify-store-ops) | Operate a live Shopify store through the **Admin GraphQL API** from one-off Node scripts |

## Install

With the [skills CLI](https://skills.sh):

```sh
npx skills add peakwagyu/shopify-store-ops
```

As a Claude Code plugin:

```
/plugin marketplace add peakwagyu/shopify-store-ops
/plugin install shopify-store-ops@peakwagyu-skills
```

Or copy a skill directory straight into `~/.claude/skills/` or a project's `.claude/skills/`:

```sh
git clone https://github.com/peakwagyu/shopify-store-ops
cp -r shopify-store-ops/skills/shopify-store-ops ~/.claude/skills/
```

## shopify-store-ops

It teaches an agent:

- how to authenticate with a custom app's **client-credentials grant** (no permanent `shpat_` token)
- how to call the Admin GraphQL endpoint, and the **two independent error layers** that both return HTTP 200
- how to write a dry-run-by-default `.mjs` script with no dependencies
- how to **reserve stock for a customer** with a draft order instead of editing inventory
- the safety rules that keep a production store intact

It deliberately does **not** teach GraphQL authoring — pair it with Shopify's own `shopify-admin`, `shopify-custom-data`, and `shopify-dev` skills.

### Setup

Three environment variables in a gitignored `.env` (see [`.env.example`](skills/shopify-store-ops/.env.example)):

```sh
PUBLIC_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_CLIENT_ID=...
SHOPIFY_ADMIN_CLIENT_SECRET=...
```

Both credentials come from a custom app in the Shopify Dev Dashboard. Grant it only the scopes you actually need — the secret carries write access to everything it's granted.

### Usage

[`assets/admin.mjs`](skills/shopify-store-ops/assets/admin.mjs) is a dependency-free client. Copy it next to a script and:

```js
import { gql, plan } from './admin.mjs';

const { shop } = await gql(`{ shop { name } }`);
if (plan(`rename ${shop.name}`)) {
  // only runs with --apply
}
```

```sh
node --env-file=.env script.mjs           # dry run
node --env-file=.env script.mjs --apply   # for real
```

Requires Node ≥20.6 for `--env-file`; verified on v22.

## License

MIT
