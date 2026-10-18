// The web app: five routes.
//
//   GET  /            home: the connect button, or what the user shared
//   GET  /connect     redirect to Haplotype Wallet's consent screen
//   GET  /callback    back from the wallet: exchange the code for tokens
//   POST /disconnect  forget this user's tokens
//   GET  /healthz     liveness check
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type Request, type Response } from "express";
import type { Config } from "./config.ts";
import { grantedWalletScopes } from "./scopes.ts";
import { type Session, SessionStore } from "./sessions.ts";
import { renderError, renderHome } from "./views.ts";
import {
  AuthorizationError,
  ReconnectRequiredError,
  WalletAuth,
  type WalletTokens,
} from "./wallet-auth.ts";
import type { Sample } from "./contract.ts";
import { AccessTokenRejectedError, listSamples, ToolError } from "./wallet-mcp.ts";

export interface AppOptions {
  /** Replaces the network for the OAuth and MCP calls (tests). */
  fetch?: typeof fetch;
  sessions?: SessionStore;
}

export function createApp(config: Config, options: AppOptions = {}): express.Express {
  const auth = new WalletAuth(config, options.fetch);
  const sessions = options.sessions ?? new SessionStore(config.appUrl);
  const app = express();

  app.disable("x-powered-by");
  app.use(cookieParser(config.sessionSecret));
  app.use("/static", express.static(fileURLToPath(new URL("../public", import.meta.url))));

  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  app.get("/", async (req, res) => {
    const session = sessions.get(req, res);
    res.set("Cache-Control", "no-store");

    const notice = session.notice;
    delete session.notice;
    if (!session.tokens) {
      res.send(renderHome({ kind: "disconnected", authError: notice?.message }));
      return;
    }

    try {
      const samples = await readSamples(session);
      res.send(
        renderHome({
          kind: "connected",
          email: session.tokens.email,
          scopes: grantedWalletScopes(session.tokens.scope),
          samples,
        }),
      );
    } catch (err) {
      if (err instanceof ReconnectRequiredError) {
        // The grant is gone. Drop the dead tokens and ask the user to connect again.
        delete session.tokens;
        res.send(renderHome({ kind: "disconnected", reconnectRequired: true }));
        return;
      }
      if (err instanceof ToolError) {
        res.send(
          renderHome({
            kind: "connected",
            email: session.tokens.email,
            scopes: grantedWalletScopes(session.tokens.scope),
            walletError: err.message,
          }),
        );
        return;
      }
      console.error("Reading samples failed:", err);
      res.status(502).send(renderError("Could not reach Haplotype Wallet. Try again in a moment."));
    }
  });

  app.get("/connect", async (req, res) => {
    const session = sessions.get(req, res);
    try {
      const { url, pending } = await auth.startAuthorization();
      session.pending = pending;
      res.redirect(url.href);
    } catch (err) {
      console.error("Starting authorization failed:", err);
      res.status(502).send(renderError("Could not reach Haplotype Wallet. Try again in a moment."));
    }
  });

  app.get("/callback", async (req, res) => {
    const session = sessions.get(req, res);
    const pending = session.pending;
    delete session.pending; // A code and state are good for one try only.
    try {
      // Build the URL from APP_URL so it matches the registered redirect URI,
      // also behind a proxy.
      const callbackUrl = new URL(req.originalUrl, config.appUrl);
      session.tokens = await auth.finishAuthorization(callbackUrl, pending);
    } catch (err) {
      if (!(err instanceof AuthorizationError)) throw err;
      console.warn(`Authorization failed: ${err.code}: ${err.message}`);
      session.notice = { kind: "auth-error", message: err.message };
    }
    res.redirect("/");
  });

  app.post("/disconnect", (req, res) => {
    const session = sessions.get(req, res);
    // This only forgets the tokens here. The grant stays in the user's wallet
    // until they disconnect the app there.
    delete session.tokens;
    delete session.pending;
    res.redirect(303, "/");
  });

  /**
   * Call `list_samples` with a fresh access token. Refreshes first when the
   * token is about to expire, and once more if the MCP endpoint rejects it.
   */
  async function readSamples(session: Session): Promise<Sample[]> {
    let tokens: WalletTokens = await auth.ensureFresh(session.tokens as WalletTokens);
    session.tokens = tokens;
    try {
      return await listSamples(config.walletMcpUrl, tokens.accessToken, options.fetch);
    } catch (err) {
      if (!(err instanceof AccessTokenRejectedError)) throw err;
      tokens = await auth.ensureFresh(tokens, true);
      session.tokens = tokens;
      return listSamples(config.walletMcpUrl, tokens.accessToken, options.fetch);
    }
  }

  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).send(renderError("Something went wrong on our side."));
  });

  return app;
}
