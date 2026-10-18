import { beforeEach, describe, expect, it } from "vitest";
import {
  AuthorizationError,
  ReconnectRequiredError,
  WalletAuth,
  type WalletTokens,
} from "../src/wallet-auth.ts";
import { config, FakeWallet, MCP_URL } from "./fake-wallet.ts";

let wallet: FakeWallet;
let auth: WalletAuth;

beforeEach(() => {
  wallet = new FakeWallet();
  auth = new WalletAuth(config, wallet.fetch);
});

function callback(params: Record<string, string>): URL {
  const url = new URL("http://localhost:8787/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

describe("startAuthorization", () => {
  it("builds the authorize URL with state, PKCE and resource", async () => {
    const { url, pending } = await auth.startAuthorization();
    expect(url.origin + url.pathname).toBe("https://wallet.test/oauth2/authorize");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("client_test");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(p.get("scope")).toBe("openid offline_access samples:read");
    expect(p.get("state")).toBe(pending.state);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBeTruthy();
    expect(p.get("resource")).toBe(MCP_URL);
  });
});

describe("finishAuthorization", () => {
  it("exchanges the code with resource, the secret and the PKCE verifier", async () => {
    const { pending } = await auth.startAuthorization();
    const tokens = await auth.finishAuthorization(
      callback({ code: "code-1", state: pending.state }),
      pending,
    );

    const form = wallet.tokenRequests[0];
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(form.get("resource")).toBe(MCP_URL);
    expect(form.get("client_id")).toBe("client_test");
    expect(form.get("client_secret")).toBe("secret_test");
    expect(form.get("code_verifier")).toBe(pending.codeVerifier);

    expect(tokens.accessToken).toBe(wallet.issued[0]);
    expect(tokens.refreshToken).toBe("refresh-1");
    // From the access token's claim: AuthKit sends no `scope` in the response.
    expect(tokens.scope).toBe("openid offline_access samples:read scores:read");
    expect(tokens.email).toBe("pat@example.com");
    expect(tokens.expiresAt - Date.now()).toBeGreaterThan(890_000);
  });

  it("prefers `scope` from the token response when the server sends it", async () => {
    wallet.tokenReplies.push({
      status: 200,
      body: { ...wallet.issueTokens(), scope: "openid samples:read" },
    });
    const { pending } = await auth.startAuthorization();
    const tokens = await auth.finishAuthorization(
      callback({ code: "code-1", state: pending.state }),
      pending,
    );
    expect(tokens.scope).toBe("openid samples:read");
  });

  it("reports a denied consent without calling the token endpoint", async () => {
    const { pending } = await auth.startAuthorization();
    const err = await auth
      .finishAuthorization(callback({ error: "access_denied", state: pending.state }), pending)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).code).toBe("access_denied");
    expect(wallet.tokenRequests).toHaveLength(0);
  });

  it("explains invalid_scope, which comes without a description", async () => {
    const err = await auth
      .finishAuthorization(callback({ error: "invalid_scope" }), undefined)
      .catch((e: unknown) => e);
    expect((err as AuthorizationError).message).toMatch(/WALLET_SCOPES/);
  });

  it("rejects a callback whose state does not match", async () => {
    const { pending } = await auth.startAuthorization();
    const err = await auth
      .finishAuthorization(callback({ code: "code-1", state: "forged" }), pending)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(wallet.tokenRequests).toHaveLength(0);
  });

  it("rejects a callback with no authorization in progress", async () => {
    const err = await auth
      .finishAuthorization(callback({ code: "code-1", state: "x" }), undefined)
      .catch((e: unknown) => e);
    expect((err as AuthorizationError).code).toBe("no_pending_authorization");
  });

  it("turns a token endpoint error into an AuthorizationError", async () => {
    wallet.tokenReplies.push({ status: 400, body: { error: "invalid_grant" } });
    const { pending } = await auth.startAuthorization();
    const err = await auth
      .finishAuthorization(callback({ code: "used", state: pending.state }), pending)
      .catch((e: unknown) => e);
    expect((err as AuthorizationError).code).toBe("invalid_grant");
  });
});

describe("ensureFresh", () => {
  const tokens = (overrides: Partial<WalletTokens> = {}): WalletTokens => ({
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: Date.now() + 10 * 60_000,
    scope: "openid offline_access samples:read",
    email: "pat@example.com",
    ...overrides,
  });

  it("keeps a token that is still good", async () => {
    const current = tokens();
    expect(await auth.ensureFresh(current)).toBe(current);
    expect(wallet.tokenRequests).toHaveLength(0);
  });

  it("refreshes an expiring token and sends resource again", async () => {
    const fresh = await auth.ensureFresh(tokens({ expiresAt: Date.now() + 30_000 }));
    const form = wallet.tokenRequests[0];
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-old");
    expect(form.get("resource")).toBe(MCP_URL);
    expect(form.get("client_secret")).toBe("secret_test");
    expect(fresh.accessToken).toBe(wallet.issued[0]);
    expect(fresh.refreshToken).toBe("refresh-1");
  });

  it("refreshes on demand even when the token looks good", async () => {
    const fresh = await auth.ensureFresh(tokens(), true);
    expect(fresh.accessToken).toBe(wallet.issued[0]);
  });

  it("keeps the old refresh token and scope when the response omits them", async () => {
    wallet.tokenReplies.push({
      status: 200,
      body: { token_type: "Bearer", access_token: "access-new", expires_in: 900 },
    });
    const fresh = await auth.ensureFresh(tokens({ expiresAt: 0 }));
    expect(fresh.accessToken).toBe("access-new");
    expect(fresh.refreshToken).toBe("refresh-old");
    expect(fresh.scope).toBe("openid offline_access samples:read");
    expect(fresh.email).toBe("pat@example.com");
  });

  it("asks to reconnect when the grant was revoked (invalid_grant)", async () => {
    wallet.tokenReplies.push({ status: 400, body: { error: "invalid_grant" } });
    await expect(auth.ensureFresh(tokens({ expiresAt: 0 }))).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
  });

  it("asks to reconnect when there is no refresh token", async () => {
    await expect(
      auth.ensureFresh(tokens({ expiresAt: 0, refreshToken: undefined })),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it("does not hide other token endpoint failures", async () => {
    wallet.tokenReplies.push({ status: 400, body: { error: "invalid_client" } });
    const err = await auth.ensureFresh(tokens({ expiresAt: 0 })).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ReconnectRequiredError);
  });
});
