// Server-side sessions. The browser holds only a random session ID in a
// signed, httpOnly cookie. Tokens live here, in memory, and never reach the
// browser.
//
// In-memory storage keeps the example short: sessions vanish on restart and
// are not shared between processes. In production, keep tokens in your
// database or a cache such as Redis, encrypted at rest.
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { PendingAuthorization, WalletTokens } from "./wallet-auth.ts";

export interface Notice {
  kind: "auth-error";
  message: string;
}

export interface Session {
  /** Set between /connect and /callback. */
  pending?: PendingAuthorization;
  tokens?: WalletTokens;
  /** A one-time message for the next page view. */
  notice?: Notice;
  /** Test hook only: the scopes the next /connect asks for. */
  testScopes?: string;
}

const COOKIE = "wallet_example_session";

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #secureCookie: boolean;

  constructor(appUrl: string) {
    this.#secureCookie = appUrl.startsWith("https://");
  }

  /** The session for this request, created (and its cookie set) if needed. */
  get(req: Request, res: Response): Session {
    const id: unknown = req.signedCookies?.[COOKIE];
    if (typeof id === "string") {
      const session = this.#sessions.get(id);
      if (session) return session;
    }
    const newId = randomBytes(32).toString("base64url");
    const session: Session = {};
    this.#sessions.set(newId, session);
    res.cookie(COOKIE, newId, {
      signed: true,
      httpOnly: true,
      // `lax` sends the cookie on the redirect back from the wallet (a
      // top-level GET) and keeps it off cross-site POSTs such as /disconnect.
      sameSite: "lax",
      secure: this.#secureCookie,
      path: "/",
    });
    return session;
  }

  /** Test helper: every live session. */
  all(): Session[] {
    return [...this.#sessions.values()];
  }
}
