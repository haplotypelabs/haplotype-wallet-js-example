// All settings come from environment variables. `pnpm start` loads `.env` if it
// exists (see .env.example). Defaults point at the production wallet.
import { WALLET_ENVIRONMENTS } from "./contract.ts";

export interface Config {
  /** AuthKit issuer. OIDC discovery runs against it. */
  walletIssuer: URL;
  /** Haplotype Wallet MCP endpoint. Also the OAuth `resource` (token audience). */
  walletMcpUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Public URL of this app. The redirect URI is `${appUrl}/callback`. */
  appUrl: string;
  port: number;
  sessionSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["WALLET_CLIENT_ID", "WALLET_CLIENT_SECRET", "SESSION_SECRET"].filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`,
    );
  }

  return {
    walletIssuer: new URL(env.WALLET_ISSUER || WALLET_ENVIRONMENTS.production.issuer),
    walletMcpUrl: env.WALLET_MCP_URL || WALLET_ENVIRONMENTS.production.mcpUrl,
    clientId: env.WALLET_CLIENT_ID as string,
    clientSecret: env.WALLET_CLIENT_SECRET as string,
    scopes: env.WALLET_SCOPES || "openid offline_access samples:read",
    appUrl: (env.APP_URL || "http://localhost:8787").replace(/\/+$/, ""),
    port: Number(env.PORT || 8787),
    sessionSecret: env.SESSION_SECRET as string,
  };
}
