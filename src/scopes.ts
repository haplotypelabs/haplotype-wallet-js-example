import { WALLET_SCOPES } from "./contract.ts";

/** Standard OpenID Connect scopes. They concern sign-in, not wallet data. */
export const OIDC_SCOPES: readonly string[] = ["openid", "profile", "email", "offline_access"];

export interface GrantedScope {
  scope: string;
  description: string;
}

/**
 * The wallet scopes in a space-delimited `scope` string, with their consent
 * wording. OIDC scopes are left out: they are about sign-in, not wallet data.
 */
export function grantedWalletScopes(scope: string): GrantedScope[] {
  return scope
    .split(/\s+/)
    .filter((s) => s && !OIDC_SCOPES.includes(s))
    .map((s) => ({
      scope: s,
      description: WALLET_SCOPES.find((w) => w.slug === s)?.description ?? s,
    }));
}
