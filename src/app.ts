// The web app: five routes.
//
//   GET  /            home: the connect button, or what the user shared
//   GET  /connect     redirect to Haplotype Wallet's consent screen
//                     (`?add_scope=` asks for one more scope)
//   GET  /callback    back from the wallet: exchange the code for tokens, or
//                     back from the wallet's account page
//   POST /disconnect  forget this user's tokens
//   GET  /healthz     liveness check
//
// With EXAMPLE_TEST_HOOKS=1 only:
//   POST /debug/expire-token  mark the access token expired, so the next page
//                             view refreshes it (for automated tests)
//   POST /debug/scopes        set the scopes the next /connect asks for
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
import { type Sample, WALLET_SCOPES } from "./contract.ts";
import { walletErrorView } from "./wallet-errors.ts";
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
            walletError: walletErrorView(err, config.appUrl),
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
    // `add_scope` asks for one more wallet scope than configured, after a
    // tool call failed with `missing_scope`. The consent screen shows again.
    const scopes = (session.testScopes ?? config.scopes).split(/\s+/);
    const extra = req.query.add_scope;
    if (typeof extra === "string" && WALLET_SCOPES.some((s) => s.slug === extra)) {
      if (!scopes.includes(extra)) scopes.push(extra);
    }
    try {
      const { url, pending } = await auth.startAuthorization(scopes.join(" "));
      session.pending = pending;
      res.redirect(url.href);
    } catch (err) {
      console.error("Starting authorization failed:", err);
      res.status(502).send(renderError("Could not reach Haplotype Wallet. Try again in a moment."));
    }
  });

  app.get("/callback", async (req, res) => {
    const session = sessions.get(req, res);
    // No code, state or error: the user is back from the wallet's account page
    // (see returnAddress in wallet-errors.ts), not from a connect attempt.
    if (!["code", "state", "error"].some((key) => key in req.query)) {
      res.redirect("/");
      return;
    }
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

  if (config.testHooks) {
    // Test-only. Without EXAMPLE_TEST_HOOKS=1 this route does not exist (404).
    app.post("/debug/expire-token", (req, res) => {
      const session = sessions.get(req, res);
      if (session.tokens) session.tokens.expiresAt = 0;
      res.sendStatus(204);
    });

    // Test-only. The scopes the next /connect asks for in this session, in
    // place of WALLET_SCOPES. With fewer scopes than a tool needs, a test can
    // reach the `missing_scope` path.
    app.post("/debug/scopes", express.urlencoded({ extended: false }), (req, res) => {
      const session = sessions.get(req, res);
      const scopes: unknown = req.body?.scopes;
      if (typeof scopes !== "string" || !scopes.trim()) {
        res.status(400).send("scopes is required");
        return;
      }
      session.testScopes = scopes.trim();
      res.sendStatus(204);
    });
  }

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
