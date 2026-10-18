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

  it("shows a tool error, such as a missing permission, without failing the page", async () => {
    await connect();
    wallet.toolResult = {
      content: [{ type: "text", text: "This app was not granted the samples:read permission." }],
      isError: true,
    };
    const html = await (await browse("/")).text();
    expect(html).toContain('data-testid="wallet-error"');
    expect(html).toContain("samples:read permission");
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
});
