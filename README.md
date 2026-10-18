# Connect Haplotype Wallet: Node.js example

A small server-side app that adds a "Connect Haplotype Wallet" button. The user
approves access on Haplotype Wallet's consent screen. The app then shows the
permissions they granted and reads their samples over MCP.

Use it as a reference for your own integration, or run it to see the whole flow
before you write any code. Full documentation:
<https://www.haplotype.ai/developers/>.

Stack: Node.js, TypeScript, Express, [`openid-client`](https://github.com/panva/openid-client)
for OAuth, and the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
for tool calls. Server-rendered HTML, no frontend framework, no client-side
JavaScript.

## Quickstart

You need:

- Node.js 22.18 or later (24 recommended; there is an `.nvmrc`) and pnpm
  (`corepack enable`). Or only Docker.
- A client ID and client secret from Haplotype Labs, with
  `http://localhost:8787/callback` registered as a redirect URI.
- A Haplotype Wallet account to connect.

Then:

```sh
git clone https://github.com/haplotypelabs/haplotype-wallet-js-example.git
cd haplotype-wallet-js-example
pnpm install
cp .env.example .env
```

Fill in `.env`:

- `WALLET_CLIENT_ID` and `WALLET_CLIENT_SECRET`: your credentials.
- `SESSION_SECRET`: any long random string, for example the output of
  `openssl rand -hex 32`.
- `WALLET_SCOPES`: only scopes your app is approved for.
- For the staging wallet, switch `WALLET_ISSUER` and `WALLET_MCP_URL` to the
  staging values listed in the file.

Start the app and open <http://localhost:8787>:

```sh
pnpm start
```

Click the button, sign in to Haplotype Wallet, approve, and you are back on
the app with your permissions and samples.

With Docker instead of Node:

```sh
docker build -t wallet-js-example .
docker run --env-file .env -p 8787:8787 wallet-js-example
```

## Configuration

| Variable               | Default                              | Notes                                                         |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `WALLET_CLIENT_ID`     | (required)                           | Your app's client ID.                                         |
| `WALLET_CLIENT_SECRET` | (required)                           | Your app's client secret. Server only.                        |
| `SESSION_SECRET`       | (required)                           | Signs the session cookie.                                     |
| `WALLET_ISSUER`        | `https://authkit.haplotype.ai`       | Authorization server. Its endpoints come from OIDC discovery. |
| `WALLET_MCP_URL`       | `https://api.haplotype.ai/mcp`       | The MCP endpoint, and the OAuth `resource`.                   |
| `WALLET_SCOPES`        | `openid offline_access samples:read` | Space-delimited.                                              |
| `APP_URL`              | `http://localhost:8787`              | The redirect URI is `APP_URL` + `/callback`.                  |
| `PORT`                 | `8787`                               |                                                               |

## How it works

1. **The button.** `GET /` shows the button, a link to `/connect`. The button
   is one file, `public/connect-button.svg`: the light version from
   https://www.haplotype.ai/developers/connect-button/, which also has the dark
   version and the rules for using it.
2. **Redirect to the wallet.** `GET /connect` runs OIDC discovery on
   `WALLET_ISSUER`, creates a random `state` and a PKCE verifier, stores both
   in the user's server-side session, and redirects to the wallet's
   `/oauth2/authorize`.
3. **Consent.** The user signs in to Haplotype Wallet and sees your app's name
   and the permissions it asks for. They allow or cancel.
4. **Callback.** The wallet redirects to `GET /callback` with a `code`, or with
   `error=access_denied` if the user cancelled. The app checks `state`, then
   posts the code, the PKCE verifier, the client secret and `resource` to
   `/oauth2/token`. It gets an access token (15 minutes), a refresh token (with
   `offline_access`) and an ID token.
5. **Read data.** `GET /` opens an MCP client on `WALLET_MCP_URL` with
   `Authorization: Bearer <access token>` and calls the `list_samples` tool.
   The samples are in the result's `structuredContent.result`.
6. **Show it.** The page lists the wallet scopes that were granted, in the
   words of the consent screen, and one row per sample. A user with no samples
   sees an empty state.

The code follows the same order:

| File                      | What it does                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/contract.ts`         | Everything that comes from the wallet's contract: production URLs, scopes and their wording, tool names, and the `list_samples` result type. Generated. |
| `src/wallet-auth.ts`      | Authorization URL, code exchange, refresh. All the OAuth rules below are here.                                                                          |
| `src/wallet-mcp.ts`       | One MCP tool call with the official SDK.                                                                                                                |
| `src/app.ts`              | The five routes.                                                                                                                                        |
| `src/sessions.ts`         | Server-side sessions behind an httpOnly cookie.                                                                                                         |
| `src/views.ts`, `public/` | HTML and CSS.                                                                                                                                           |

## The `resource` trap

Send `resource=<WALLET_MCP_URL>` on the token request and on every refresh
request:

```ts
await oidc.authorizationCodeGrant(config, callbackUrl, checks, { resource: MCP_URL });
await oidc.refreshTokenGrant(config, refreshToken, { resource: MCP_URL });
```

The authorization server sets the access token's audience from the `resource`
it receives at the token endpoint. Sending it only on the authorize request is
not enough. Without it you get a token that looks valid, and the MCP endpoint
answers `401`. The same happens after a refresh without `resource`, so it often
shows up 15 minutes after a working first call.

## Other details that matter

- **Granted scopes are in the access token.** The token response from the code
  exchange has no `scope` field. The app reads the access token's `scope` claim
  for display (`scopeClaim` in `src/wallet-auth.ts`). Do not assume the grant
  equals what you asked for: if the user already approved your app, a request
  for fewer scopes returns the existing grant.
- **Ask only for approved scopes.** A scope your app is not approved for fails
  before any screen, with `error=invalid_scope` on the callback and no
  description. The app shows a message that points at `WALLET_SCOPES`.
- **`offline_access` gives the refresh token.** Without it the user has to
  connect again every 15 minutes.
- **Confidential client.** The client secret and all tokens stay on your
  server. Browser-only and mobile clients are not supported.
- **PKCE.** The app sends a PKCE challenge as well as the client secret, and
  the wallet checks it: a wrong verifier fails with `invalid_grant`.
- **The MCP endpoint is stateless.** No session to keep between calls. The app
  opens a client per page load and closes it.

## Refresh, disconnect and revocation

- **Refresh.** Access tokens last 15 minutes. Before calling a tool, the app
  refreshes the token if it expires within a minute. If the MCP endpoint still
  answers `401`, it refreshes once and retries.
- **The user disconnects your app in Haplotype Wallet.** The refresh token stops
  working at once and a refresh fails with `invalid_grant`. The access token
  already issued keeps working until it expires, at most 15 minutes. On
  `invalid_grant` the app drops the tokens and asks the user to connect again.
- **The Disconnect button in this app** only makes the app forget the tokens.
  The grant stays in the user's wallet until they remove it there. The next
  connect skips the consent screen while the grant exists.

## Keeping tokens off the browser

The browser holds one cookie: a random session ID, signed with
`SESSION_SECRET`, `httpOnly`, `SameSite=Lax`, and `Secure` when `APP_URL` is
https. Tokens live in server memory, keyed by that ID. They are never rendered
into a page or put in a cookie.

The in-memory store keeps the example short: sessions are lost on restart and
are not shared between processes. In production, store tokens in your database
or a cache, encrypted at rest, and tie them to your own user accounts.

## Page states and test hooks

Elements carry `data-testid` attributes for automated tests:

| `data-testid`        | When                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `connect-button`     | Not connected.                                                      |
| `granted-scope`      | One per granted wallet scope, with `data-scope="samples:read"` etc. |
| `sample-row`         | One per sample: label, original filename, processed date.           |
| `samples-empty`      | Connected, no samples.                                              |
| `auth-error`         | Consent denied, or another error on the way back.                   |
| `reconnect-required` | The refresh failed (the user disconnected the app in the wallet).   |
| `disconnect-button`  | Connected.                                                          |
| `wallet-error`       | A tool call failed, e.g. a missing permission.                      |

`GET /healthz` answers `200 ok`.

## Testing

The unit tests in `test/` run the OAuth and refresh logic and the routes
against a fake wallet (`test/fake-wallet.ts`). They make no network calls:

```sh
pnpm test
```

End-to-end tests drive the running app in a browser against a real wallet
environment. For them, start the app with `EXAMPLE_TEST_HOOKS=1`, which adds
one route:

- `POST /debug/expire-token` marks the current session's access token as
  expired and answers `204`. The next page view refreshes the token. This lets
  a test check refresh, and the `reconnect-required` state after the user
  disconnects the app in the wallet, without waiting 15 minutes.

Without `EXAMPLE_TEST_HOOKS=1` the route is not registered and answers `404`.

## Wallet contract

`src/contract.ts` is generated. Do not edit it. Its source is
`contract/connect-contract.json`, a copy of the contract Haplotype Wallet
publishes at <https://www.haplotype.ai/developers/connect-contract.json>:
endpoints, scopes with their consent wording, and tool schemas.
`scripts/generate-contract.ts` turns it into the module, with result types for
the tools this app calls (`APP_TOOLS` in the script).

To regenerate after changing the JSON or the script:

```sh
pnpm contract:generate
```

`pnpm lint` (and so CI) fails when `src/contract.ts` does not match the JSON.

Updates arrive as pull requests. The `Update wallet contract` workflow fetches
the published contract, regenerates the module, runs lint, typecheck and tests,
and opens or updates a PR from the `contract-update` branch if anything
changed. It runs when Haplotype Wallet releases a contract change, daily as a
fallback, and by hand (`gh workflow run update-contract.yml`, optionally with
`-f contract_url=<url>`).

## Development

```sh
pnpm dev      # restart on file changes
pnpm check    # lint, format check, typecheck, unit tests
pnpm format   # fix formatting
```

Node runs the TypeScript sources directly (type stripping), so there is no
build step.

## License

MIT. See [LICENSE](LICENSE).
