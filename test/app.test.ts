import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { SessionStore } from "../src/sessions.ts";
import { config, FakeWallet, sample } from "./fake-wallet.ts";

let wallet: FakeWallet;
let sessions: SessionStore;
let server: Server;
let base: string;
let cookie = "";

async function start(overrides: Partial<Config> = {}): Promise<void> {
  wallet = new FakeWallet();
  sessions = new SessionStore(config.appUrl);
  server = createApp({ ...config, ...overrides }, { fetch: wallet.fetch, sessions }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = "";
}

beforeEach(() => start());

afterEach(() => new Promise((resolve) => server.close(resolve)));

/** A browser with a cookie jar of one cookie, which does not follow redirects. */
async function browse(path: string, method = "GET"): Promise<Response> {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

/** Run /connect and /callback as if the user approved. */
async function connect(): Promise<string> {
  const start = await browse("/connect");
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") as string);
  const state = authorize.searchParams.get("state") as string;
  const back = await browse(`/callback?code=code-1&state=${encodeURIComponent(state)}`);
  expect(back.headers.get("location")).toBe("/");
  return (await browse("/")).text();
}

const expireTokens = () => {
  for (const session of sessions.all()) if (session.tokens) session.tokens.expiresAt = 0;
};

describe("app", () => {
  it("answers health checks", async () => {
    const res = await browse("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("shows the connect button to a new visitor", async () => {
    const html = await (await browse("/")).text();
    expect(html).toContain('data-testid="connect-button"');
    expect(html).toContain('href="/connect"');
  });

  it("shows granted wallet scopes and samples after consent", async () => {
    wallet.samples = [sample(1), sample(2)];
    const html = await connect();

    expect(html.match(/data-testid="granted-scope"/g)).toHaveLength(2);
    expect(html).toContain('data-scope="samples:read"');
    expect(html).toContain('data-scope="scores:read"');
    expect(html).not.toContain('data-scope="openid"');
    expect(html.match(/data-testid="sample-row"/g)).toHaveLength(2);
    expect(html).toContain("genome_1.txt");
    expect(html).toContain("Oct 1, 2026");
    expect(html).toContain('data-testid="disconnect-button"');
    expect(wallet.mcpTokens.every((t) => t === wallet.issued[0])).toBe(true);
  });

  it("never sends tokens to the browser", async () => {
    const html = await connect();
    for (const secret of [wallet.issued[0], "refresh-1"]) {
      expect(html).not.toContain(secret);
      expect(cookie).not.toContain(secret);
    }
  });

  it("shows an empty state when the user has no samples", async () => {
    const html = await connect();
    expect(html).toContain('data-testid="samples-empty"');
    expect(html).not.toContain('data-testid="sample-row"');
  });

  it("shows an error after the user denies consent", async () => {
    const start = await browse("/connect");
    const state = new URL(start.headers.get("location") as string).searchParams.get("state");
    await browse(`/callback?error=access_denied&state=${state}`);
    const html = await (await browse("/")).text();
    expect(html).toContain('data-testid="auth-error"');
    expect(html).toContain('data-testid="connect-button"');
    // The message is shown once.
    expect(await (await browse("/")).text()).not.toContain('data-testid="auth-error"');
  });

  it("refreshes an expired access token transparently", async () => {
    wallet.samples = [sample(1)];
    await connect();
    expireTokens();
    const html = await (await browse("/")).text();
    expect(html).toContain('data-testid="sample-row"');
    expect(wallet.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(wallet.mcpTokens.at(-1)).toBe(wallet.issued[1]);
  });

  it("refreshes once when the MCP endpoint rejects the access token", async () => {
    await connect();
    wallet.rejectedTokens.add(wallet.issued[0]);
    const html = await (await browse("/")).text();
    expect(html).toContain('data-testid="samples-empty"');
    expect(wallet.mcpTokens.at(-1)).toBe(wallet.issued[1]);
  });

  it("asks to connect again when the grant was revoked in the wallet", async () => {
    await connect();
    expireTokens();
    wallet.tokenReplies.push({ status: 400, body: { error: "invalid_grant" } });
    const html = await (await browse("/")).text();
    expect(html).toContain('data-testid="reconnect-required"');
    expect(html).toContain('data-testid="connect-button"');
    expect(sessions.all().some((s) => s.tokens)).toBe(false);
  });

  describe("tool errors, by the wallet's error code", () => {
    const failWith = (text: string, envelope: Record<string, unknown>) => {
      wallet.toolResult = {
        content: [{ type: "text", text }],
        isError: true,
        _meta: { "ai.haplotype/error": envelope },
      };
    };

    it("a billing code asks to renew the plan, with a way back", async () => {
      await connect();
      failWith("Your free trial has ended. ...", {
        code: "trial_ended",
        retryable: false,
        manage_url: "https://www.haplotype.ai/app/account/?client_id=client_test",
      });
      const html = await (await browse("/")).text();

      expect(html).toContain('data-code="trial_ended"');
      expect(html).toContain("Renew your Haplotype Wallet plan");
      const href = html.match(/href="([^"]+)" data-testid="renew-plan"/)?.[1];
      const url = new URL((href ?? "").replaceAll("&amp;", "&"));
      expect(url.origin + url.pathname).toBe("https://www.haplotype.ai/app/account/");
      expect(url.searchParams.get("client_id")).toBe("client_test");
      expect(url.searchParams.get("return_to")).toBe("http://localhost:8787/callback");
    });

    it("missing_scope offers to connect again for that scope", async () => {
      await connect();
      failWith("This app was not granted the samples:read permission ...", {
        code: "missing_scope",
        retryable: false,
        scope: "samples:read",
      });
      const html = await (await browse("/")).text();

      expect(html).toContain('data-code="missing_scope"');
      expect(html).toContain(
        'href="/connect?add_scope=samples%3Aread" data-testid="reconnect-scope" data-scope="samples:read"',
      );
      const start = await browse("/connect?add_scope=samples%3Aread");
      const scope = new URL(start.headers.get("location") as string).searchParams.get("scope");
      expect(scope).toBe("openid offline_access samples:read");
    });

    it("asks only for wallet scopes the contract knows", async () => {
      const start = await browse("/connect?add_scope=admin%3Aall");
      const scope = new URL(start.headers.get("location") as string).searchParams.get("scope");
      expect(scope).toBe(config.scopes);
    });

    it("a retryable code says try again", async () => {
      await connect();
      failWith("Listing samples failed because a data service did not answer. (ref: 5f0c2a1e).", {
        code: "upstream_unavailable",
        retryable: true,
        ref: "5f0c2a1e",
      });
      const html = await (await browse("/")).text();

      expect(html).toContain('data-code="upstream_unavailable"');
      expect(html).toContain('data-testid="retry"');
    });

    it("anything else shows the message and the error reference", async () => {
      await connect();
      failWith(
        "Internal error in list_samples (ref: 5f0c2a1e). If this looks like a bug, tell the user ...",
        { code: "internal_error", retryable: false, ref: "5f0c2a1e" },
      );
      const html = await (await browse("/")).text();

      expect(html).toContain('data-code="internal_error"');
      expect(html).toContain("Internal error in list_samples");
      expect(html).not.toContain("tell the user");
      expect(html).toContain('<code data-testid="error-ref">5f0c2a1e</code>');
    });

    it("a code it does not know is treated as internal_error", async () => {
      await connect();
      failWith("Something new.", { code: "brand_new", retryable: true });
      const html = await (await browse("/")).text();
      expect(html).toContain('data-code="internal_error"');
      expect(html).not.toContain('data-testid="retry"');
    });
  });

  it("comes back from the wallet's account page without an error", async () => {
    await connect();
    const back = await browse("/callback");
    expect(back.headers.get("location")).toBe("/");
    const html = await (await browse("/")).text();
    expect(html).not.toContain('data-testid="auth-error"');
    expect(html).toContain('data-testid="disconnect-button"');
  });

  it("forgets the tokens on disconnect", async () => {
    await connect();
    const res = await browse("/disconnect", "POST");
    expect(res.status).toBe(303);
    const html = await (await browse("/")).text();
    expect(html).toContain('data-testid="connect-button"');
    expect(sessions.all().some((s) => s.tokens)).toBe(false);
  });

  it("has no test hooks unless EXAMPLE_TEST_HOOKS=1", async () => {
    await connect();
    const res = await browse("/debug/expire-token", "POST");
    expect(res.status).toBe(404);
    expect(sessions.all().find((s) => s.tokens)?.tokens?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("expires the access token through the test hook, so the next view refreshes", async () => {
    await new Promise((resolve) => server.close(resolve));
    await start({ testHooks: true });
    await connect();
    const res = await browse("/debug/expire-token", "POST");
    expect(res.status).toBe(204);
    const html = await (await browse("/")).text();
    expect(html).toContain('data-testid="samples-empty"');
    expect(wallet.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(wallet.mcpTokens.at(-1)).toBe(wallet.issued[1]);
  });

  it("sets the scopes of the next connect through the test hook", async () => {
    await new Promise((resolve) => server.close(resolve));
    await start({ testHooks: true });
    await browse("/");
    const res = await fetch(`${base}/debug/scopes`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "scopes=openid+offline_access+scores%3Aread",
    });
    expect(res.status).toBe(204);
    const begin = await browse("/connect");
    const scope = new URL(begin.headers.get("location") as string).searchParams.get("scope");
    expect(scope).toBe("openid offline_access scores:read");
  });
});
