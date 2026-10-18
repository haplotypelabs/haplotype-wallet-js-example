// OAuth 2.0 authorization code flow against Haplotype Wallet's authorization
// server (WorkOS AuthKit), using openid-client.
//
// The one rule that trips everyone up: send `resource=<WALLET_MCP_URL>` on the
// token request and on EVERY refresh request, not only on the authorize
// request. AuthKit sets the access token's audience (`aud`) from the `resource`
// sent to the token endpoint. Without it the token's audience is wrong and the
// MCP endpoint answers 401, even though the token looks valid.
import * as oidc from "openid-client";
import type { Config } from "./config.ts";

export interface WalletTokens {
  accessToken: string;
  refreshToken?: string;
  /** When the access token expires, in epoch milliseconds. */
  expiresAt: number;
  /** Space-delimited scopes the user granted. */
  scope: string;
  /** The user's email from the ID token, for display only. */
  email?: string;
}

/** What we remember between redirecting to the wallet and the callback. */
export interface PendingAuthorization {
  state: string;
  codeVerifier: string;
}

/** The user denied consent, or the authorization server returned an error. */
export class AuthorizationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The refresh token no longer works, usually because the user disconnected
 * this app in Haplotype Wallet. The only way forward is to connect again.
 */
export class ReconnectRequiredError extends Error {}

/** Refresh this long before the access token expires (15 minutes by default). */
const REFRESH_MARGIN_MS = 60_000;

export class WalletAuth {
  readonly #settings: Config;
  readonly #fetch: typeof fetch | undefined;
  #configuration: Promise<oidc.Configuration> | undefined;

  /** `fetchImpl` lets tests replace the network. */
  constructor(settings: Config, fetchImpl?: typeof fetch) {
    this.#settings = settings;
    this.#fetch = fetchImpl;
  }

  get redirectUri(): string {
    return `${this.#settings.appUrl}/callback`;
  }

  /** Step 1: build the authorize URL the user's browser is sent to. */
  async startAuthorization(
    scope: string = this.#settings.scopes,
  ): Promise<{ url: URL; pending: PendingAuthorization }> {
    const config = await this.#discover();
    const pending: PendingAuthorization = {
      // `state` ties the callback to this browser session (CSRF protection).
      state: oidc.randomState(),
      // PKCE on top of the client secret: a stolen code is useless without
      // the verifier, which never leaves this server.
      codeVerifier: oidc.randomPKCECodeVerifier(),
    };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope,
      state: pending.state,
      code_challenge: await oidc.calculatePKCECodeChallenge(pending.codeVerifier),
      code_challenge_method: "S256",
      // AuthKit ignores `resource` here, but it is the standard place for it
      // (RFC 8707), so send it anyway. The token request below is what counts.
      resource: this.#settings.walletMcpUrl,
    });
    return { url, pending };
  }

  /** Step 2: the user is back on /callback. Exchange the code for tokens. */
  async finishAuthorization(
    callbackUrl: URL,
    pending: PendingAuthorization | undefined,
  ): Promise<WalletTokens> {
    // The user clicked "Deny", or the request was rejected before any screen
    // (for example `invalid_scope`: a scope this app is not approved for).
    const error = callbackUrl.searchParams.get("error");
    if (error) {
      const description = callbackUrl.searchParams.get("error_description");
      throw new AuthorizationError(error, describeAuthorizeError(error, description));
    }
    if (!pending) {
      throw new AuthorizationError(
        "no_pending_authorization",
        "This sign-in link has expired or was already used. Please connect again.",
      );
    }

    const config = await this.#discover();
    try {
      const response = await oidc.authorizationCodeGrant(
        config,
        callbackUrl,
        { expectedState: pending.state, pkceCodeVerifier: pending.codeVerifier },
        // THE TRAP: without `resource` here, `aud` is wrong and /mcp answers 401.
        { resource: this.#settings.walletMcpUrl },
      );
      return toWalletTokens(response);
    } catch (err) {
      if (err instanceof oidc.ResponseBodyError) {
        // E.g. `invalid_grant`: the code expired, was used twice, or the PKCE
        // verifier did not match.
        throw new AuthorizationError(
          err.error,
          `Haplotype Wallet refused the sign-in (${err.error_description ?? err.error}). Please connect again.`,
        );
      }
      if (err instanceof oidc.ClientError) {
        throw new AuthorizationError("invalid_callback", err.message);
      }
      throw err;
    }
  }

  /**
   * Return tokens with an access token that is good for at least another
   * minute, refreshing if needed. Pass `force` after the MCP server rejected
   * the current access token.
   */
  async ensureFresh(tokens: WalletTokens, force = false): Promise<WalletTokens> {
    if (!force && tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return tokens;
    return this.refresh(tokens);
  }

  /** Swap the refresh token for a new access token. */
  async refresh(tokens: WalletTokens): Promise<WalletTokens> {
    if (!tokens.refreshToken) {
      // There is no refresh token without the `offline_access` scope.
      throw new ReconnectRequiredError("The access token expired and there is no refresh token.");
    }
    const config = await this.#discover();
    try {
      const response = await oidc.refreshTokenGrant(config, tokens.refreshToken, {
        // THE TRAP again: a refresh without `resource` returns a token with the
        // wrong audience, and /mcp answers 401.
        resource: this.#settings.walletMcpUrl,
      });
      return toWalletTokens(response, tokens);
    } catch (err) {
      // `invalid_grant` means the grant is gone: the user disconnected this app
      // in Haplotype Wallet, or the session hit its maximum lifetime.
      if (err instanceof oidc.ResponseBodyError && err.error === "invalid_grant") {
        throw new ReconnectRequiredError("Haplotype Wallet no longer accepts this connection.");
      }
      throw err;
    }
  }

  /** OIDC discovery, cached. A failure is retried on the next call. */
  #discover(): Promise<oidc.Configuration> {
    this.#configuration ??= oidc
      .discovery(
        this.#settings.walletIssuer,
        this.#settings.clientId,
        // A confidential client: the secret goes in the token request body
        // (client_secret_post). It never reaches the browser.
        this.#settings.clientSecret,
        undefined,
        this.#fetch ? { [oidc.customFetch]: this.#fetch } : undefined,
      )
      .then((config) => {
        if (this.#fetch) config[oidc.customFetch] = this.#fetch;
        return config;
      })
      .catch((err: unknown) => {
        this.#configuration = undefined;
        throw err;
      });
    return this.#configuration;
  }
}

function toWalletTokens(
  response: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
  previous?: WalletTokens,
): WalletTokens {
  const email = response.claims()?.email;
  return {
    accessToken: response.access_token,
    // Keep the old refresh token if the server did not send a new one.
    refreshToken: response.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (response.expiresIn() ?? 900) * 1000,
    scope: response.scope ?? scopeClaim(response.access_token) ?? previous?.scope ?? "",
    email: typeof email === "string" ? email : previous?.email,
  };
}

/**
 * AuthKit leaves `scope` out of the token response, so read what was granted
 * from the access token's `scope` claim. The token is a JWT we just received
 * from the token endpoint over TLS; this decodes it for display only and is
 * no substitute for verification, which is the MCP server's job.
 *
 * Do not assume the grant equals what you requested: an existing grant is
 * returned as is, even when the request asked for less.
 */
function scopeClaim(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
    return typeof payload.scope === "string" ? payload.scope : undefined;
  } catch {
    return undefined;
  }
}

function describeAuthorizeError(error: string, description: string | null): string {
  switch (error) {
    case "access_denied":
      return "You chose not to connect Haplotype Wallet. Nothing was shared.";
    case "invalid_scope":
      // AuthKit sends no description for this one.
      return "This app asked for a permission it is not approved for (invalid_scope). Check WALLET_SCOPES.";
    default:
      return `Haplotype Wallet returned an error: ${description ?? error}.`;
  }
}
