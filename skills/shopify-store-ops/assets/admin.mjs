/**
 * Minimal Shopify Admin API client for one-off ops scripts.
 *
 * Copy this file next to your script and import it:
 *   import { gql, applyFlag } from './admin.mjs';
 *
 * Run with:  node --env-file=.env your-script.mjs [--apply]
 */

const API_VERSION = '2026-04';

const storeDomain = process.env.PUBLIC_STORE_DOMAIN;
if (!storeDomain) throw new Error('PUBLIC_STORE_DOMAIN not set (is --env-file=.env missing?)');

let tokenPromise;

/** Client-credentials grant → 24h Admin API token. Minted once per process. */
function resolveAdminToken() {
  tokenPromise ??= (async () => {
    const clientId = process.env.SHOPIFY_ADMIN_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_ADMIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('Set SHOPIFY_ADMIN_CLIENT_ID + SHOPIFY_ADMIN_CLIENT_SECRET');
    }
    const res = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    if (!json.access_token) throw new Error('no access_token in response');
    return json.access_token;
  })();
  return tokenPromise;
}

/**
 * Run an Admin GraphQL operation. Throws on transport errors AND on any
 * non-empty `userErrors` found anywhere in the response.
 */
export async function gql(query, variables = {}) {
  const token = await resolveAdminToken();
  const res = await fetch(`https://${storeDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  if (!json.data) throw new Error(`GraphQL returned no data: ${JSON.stringify(json)}`);
  throwOnUserErrors(json.data);
  return json.data;
}

/** Mutations report business-logic failures in `userErrors` with HTTP 200. */
function throwOnUserErrors(data) {
  for (const [field, value] of Object.entries(data ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const errs = value.userErrors ?? value.mediaUserErrors;
    if (Array.isArray(errs) && errs.length) {
      throw new Error(`${field} userErrors: ${JSON.stringify(errs)}`);
    }
  }
}

/** True only when --apply was passed. Everything destructive must be gated on this. */
export const applyFlag = process.argv.includes('--apply');

/** Log a planned mutation; returns whether to actually perform it. */
export function plan(description) {
  console.log(`${applyFlag ? 'APPLY' : 'DRY  '}  ${description}`);
  return applyFlag;
}
