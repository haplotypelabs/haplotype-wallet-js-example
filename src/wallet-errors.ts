// What to show when a tool call fails. The wallet sends a stable code with
// every error (`ToolError.info`), and the app acts on the code, never on the
// message text, which is written for AI assistants.
//
//   billing codes     "Renew your Haplotype Wallet plan", a link to the
//                     wallet's account page, and a way back here
//   missing_scope     offer to connect again, asking for that scope
//   retryable codes   "try again"
//   anything else     the message and the error reference
//
// Codes: https://www.haplotype.ai/developers/connect-wallet/#in-a-tool-result
import { WALLET_SCOPES, type WalletErrorCode } from "./contract.ts";
import type { ToolError } from "./wallet-mcp.ts";

export type WalletErrorView =
  | {
      kind: "billing";
      code: WalletErrorCode;
      message: string;
      /** The wallet's account page, with a way back to this app. */
      renewUrl?: string;
    }
  | {
      kind: "missing-scope";
      code: WalletErrorCode;
      scope: string;
      /** The consent screen's wording for the scope. */
      description: string;
      /** Starts the connect flow again, asking for the scope too. */
      reconnectUrl: string;
    }
  | { kind: "retry"; code: WalletErrorCode }
  | { kind: "other"; code: WalletErrorCode; message: string; ref?: string };

const BILLING_MESSAGES: Partial<Record<WalletErrorCode, string>> = {
  trial_ended: "Your Haplotype Wallet free trial has ended. Subscribe to keep using it here.",
  subscription_ended:
    "Your Haplotype Wallet subscription has ended. Renew it to keep using it here.",
  limit_reached:
    "This would go over what your Haplotype Wallet plan includes. Change your plan to continue.",
};

/**
 * Where the user returns after managing their plan. The wallet's account page
 * accepts only one of this app's registered redirect URIs, and the callback is
 * the one this app always has.
 */
export function returnAddress(appUrl: string): string {
  return `${appUrl}/callback`;
}

export function walletErrorView(err: ToolError, appUrl: string): WalletErrorView {
  const { code, retryable, ref, scope, manageUrl } = err.info;

  const billing = BILLING_MESSAGES[code];
  if (billing) {
    let renewUrl: string | undefined;
    if (manageUrl) {
      const url = new URL(manageUrl);
      url.searchParams.set("return_to", returnAddress(appUrl));
      renewUrl = url.href;
    }
    return { kind: "billing", code, message: billing, renewUrl };
  }

  if (code === "missing_scope" && scope) {
    const known = WALLET_SCOPES.find((s) => s.slug === scope);
    if (known) {
      return {
        kind: "missing-scope",
        code,
        scope,
        description: known.description,
        reconnectUrl: `/connect?add_scope=${encodeURIComponent(scope)}`,
      };
    }
  }

  if (retryable) return { kind: "retry", code };

  // The wallet's message ends with the reference and a hint for AI
  // assistants. People get the first part, and the reference on its own.
  return { kind: "other", code, message: err.message.split(" (ref: ")[0], ref };
}
