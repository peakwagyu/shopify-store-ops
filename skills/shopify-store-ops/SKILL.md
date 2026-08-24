---
name: shopify-store-ops
description: How to authenticate to and operate a Shopify store through the Admin GraphQL API from one-off Node scripts, using a custom app's client credentials. Use whenever a task touches live store data — products, variants, inventory, orders, order edits, draft orders, fulfillments, discounts, customers, metafields, shipping rates, publications — or when a Shopify call returns ACCESS_DENIED, THROTTLED, or userErrors. Covers credentials, the token exchange, the endpoint, reserving stock safely, and the safety rules for mutating a live store. Does not cover authoring the GraphQL itself.
---

# Shopify store ops

Operate a live Shopify store by writing a small Node script that calls the **Admin GraphQL API** directly. Not the Shopify CLI, not an MCP server — a script is re-runnable, reviewable, and leaves a record of what was done.

This is a **real store with real money in it**. Every write is against production. Read "Rules" below before your first mutation.

## Credentials

Three environment variables, conventionally in a gitignored `.env`:

| Variable | What it is |
|---|---|
| `PUBLIC_STORE_DOMAIN` | the `*.myshopify.com` domain the API is addressed at |
| `SHOPIFY_ADMIN_CLIENT_ID` | the custom app's client ID |
| `SHOPIFY_ADMIN_CLIENT_SECRET` | its secret — **write access to the whole store** |

Load them with Node's own `--env-file=.env`. Never hardcode them, never inline them into a shell command, never `echo`/`console.log` the secret or a minted token, and never send them anywhere but `https://$PUBLIC_STORE_DOMAIN`.

If the project also has Storefront API tokens, they are a **different, read-only** credential system and are not interchangeable with these: an Admin token can't read the storefront, and a Storefront token can't mutate anything.

## Getting a token

Modern custom apps have no permanent `shpat_` token. They use the **OAuth client-credentials grant**: exchange id+secret for an access token that lives **24 hours** (`expires_in: 86399`). Mint it fresh at the start of every run — it's one cheap request, it always reflects currently-granted scopes, and there's no cache to invalidate.

```js
const res = await fetch(`https://${process.env.PUBLIC_STORE_DOMAIN}/admin/oauth/access_token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SHOPIFY_ADMIN_CLIENT_ID,
    client_secret: process.env.SHOPIFY_ADMIN_CLIENT_SECRET,
  }),
});
const { access_token } = await res.json();
```

Never write the token to a file, or to an env var that outlives the process.

## Calling the API

```
POST https://${PUBLIC_STORE_DOMAIN}/admin/api/<version>/graphql.json
Content-Type: application/json
X-Shopify-Access-Token: <the minted token>

{ "query": "...", "variables": { ... } }
```

**Pin one API version and use it everywhere.** Never let a single script drift onto a different version. If the app is CLI-managed, match the `api_version` in its `shopify.app.toml`. The examples here and in `assets/admin.mjs` use `2026-04`.

**Failures arrive on two separate layers, and both return HTTP 200:**

1. `json.errors` — the query didn't parse, a field doesn't exist, or the token lacks the scope (`ACCESS_DENIED`).
2. `json.data.<mutationName>.userErrors` — the query was valid but the operation was rejected (bad input, insufficient inventory, invalid state). **An unchecked `userErrors` looks exactly like success.** Check it on every mutation.

Responses carry `extensions.cost.throttleStatus`. The bucket is 2000 points restoring at 100/s; on `THROTTLED`, back off and retry rather than hammering.

## Writing the script

Use **`.mjs`** and run it with plain Node — no TypeScript, no dependencies, no install step:

```sh
node --env-file=.env <name>.mjs           # dry run
node --env-file=.env <name>.mjs --apply   # for real
```

Verified on Node v22 (`--env-file` needs ≥20.6). Top-level `await` works, `fetch` is built in.

`assets/admin.mjs` is a ready-made client — copy it next to your script and import `gql`, `applyFlag`, and `plan`. It handles the token exchange, the endpoint, and both error layers.

Conventions worth following:

- **Dry run by default; `--apply` to mutate.** A dry run prints the exact plan — every object it would touch, old value → new value — and touches nothing. Show the user the dry run before you apply.
- **Idempotent where possible.** Upsert by handle or SKU rather than creating blindly.
- **Read before you write.** Fetch current state, diff it, then mutate only what differs.
- **Paginate properly.** Anything over 250 rows needs a cursor loop; a bare `first: 250` with no `pageInfo` check silently truncates and makes the plan look complete:

  ```js
  let after = null, out = [];
  do {
    const d = await gql(`query($after: String) {
      products(first: 250, query: "status:active", after: $after) {
        nodes { id handle }
        pageInfo { hasNextPage endCursor }
      }
    }`, { after });
    out.push(...d.products.nodes);
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  ```

Prefer a script over an interactive one-liner even for reads — it's re-runnable and reviewable. Keep throwaway scripts in a scratch directory; keep anything worth running twice in the project.

## Scopes

`ACCESS_DENIED` means the scope isn't granted — **not** that the token is stale, and re-minting won't help. Granting a new scope takes a human: stop and tell the user which scope is missing. If the app is CLI-managed, they add it to `[access_scopes]` in `shopify.app.toml`, release a new app version, and **approve the added permission in the Shopify admin** before the next token carries it. Don't try to route around it.

## Reserving stock for a customer

When specific units should go to someone — an event order, a comp, a partner package, an invoice the customer will take days to pay — **create a draft order. Do not move inventory.**

`draftOrderCreate` with `reserveInventoryUntil` (a DateTime) moves those line quantities out of `available` into the `reserved` state until that timestamp, so the storefront cannot sell them. This is Shopify's own guidance: the `inventoryMoveQuantities` docs say to use a draft order rather than manually moving units to `reserved`.

```graphql
mutation($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id name totalPriceSet { shopMoney { amount } } }
    userErrors { field message }
  }
}
```

```json
{ "input": {
    "lineItems": [{ "variantId": "gid://shopify/ProductVariant/...", "quantity": 4 }],
    "reserveInventoryUntil": "2026-09-07T00:00:00Z",
    "note": "why these units are held, and for whom",
    "tags": ["hold"]
} }
```

- **No customer is required — and you must not invent one.** Every `DraftOrderInput` field is optional; the only constraints are at least one line item and at most 499. A dummy customer or email pollutes the customer list and reporting, and can be sent a real invoice by the admin's "Send invoice" button. Put the reason in `note` and `tags`; attach the real customer when there is one.
- **Reservations expire silently.** On the expiry date the units flow back to `available` and go on sale, with no notification. Always tell the user the expiry date when you create one.
- **`draftOrderCalculate` does not persist.** Use it freely to check totals, tax, discount-code eligibility and shipping rates before creating anything.
- Discount codes work via `discountCodes`; pair with `acceptAutomaticDiscounts: false` so only the named code applies. A free-shipping code zeroes an explicit `shippingLine`, so set the real rate and let the code discount it — the order still records the shipping method for the warehouse.
- On payment, `reserved` → `committed` automatically and it becomes a real order, visible to downstream fulfillment.
- Verify with a read of `quantities(names: ["available","committed","reserved","on_hand","safety_stock"])` — `on_hand` unchanged, `reserved` = the order quantity. Never verify by re-running the create.

**Don't hold stock by editing inventory.** Moving `available` → `safety_stock` is only for an indefinite hold with no recipient, and un-parking it later is a multi-step sequence with a window where a one-of-a-kind item goes back on sale. Never lower `on_hand` to hide stock — that corrupts the warehouse's count. If a task seems to need either, ask the user rather than improvising. Never hold the same units two ways at once; that double-counts them.

**Adding stock to an already-paid order** cannot be done with a draft — it needs an order edit (`orderEditBegin` → `orderEditAddVariant` → `orderEditCommit`), which is **not idempotent**: committing twice bills twice. Downstream fulfillment systems may also pick up an edit late or not at all, so an edit close to a shipment can miss the pick list entirely. Confirm with the user before starting one.

## Rules

Non-negotiable, and each one is here because it has already gone wrong in production:

1. **Run a mutating script exactly once.** Verify with a *separate read-only query* — never by re-running the script. Re-running a create duplicates order lines; re-running an `inventoryMoveQuantities` moves another unit rather than reporting the first move.
2. **Never trust a count from a file or an external system.** Spreadsheets, exports, and WMS dashboards go stale, and warehouse "in stock" figures often still include units that are allocated or already shipped. Cross-check against Shopify's open orders before writing any quantity anywhere.
3. **Use `on_hand`, not `available`, for any reconcile.** Reserved, committed, and safety-stock units are all still physically on the shelf.
4. **Anything irreversible or customer-facing** — charging, refunding, emailing, publishing, deleting — gets confirmed with the user first, even in a dry-run-then-apply flow.

## Where to look things up

Authoring the GraphQL itself — operation names, argument shapes, input types — is out of scope here. Use the **`shopify-admin`** skill for Admin API operations, **`shopify-custom-data`** for metafields and metaobjects (first, whenever either is mentioned), and **`shopify-dev`** to search the docs for anything else. If those aren't installed, the schema is introspectable with the token you just minted.
