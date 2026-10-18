// A fake Haplotype Wallet for tests: OIDC discovery, the token endpoint and
// the MCP endpoint, served through a `fetch` replacement. No network.
import type { Config } from "../src/config.ts";
import type { Sample } from "../src/contract.ts";

export const ISSUER = "https://wallet.test";
export const MCP_URL = "https://api.wallet.test/mcp";

export const config: Config = {
  walletIssuer: new URL(ISSUER),
  walletMcpUrl: MCP_URL,
  clientId: "client_test",
  clientSecret: "secret_test",
  scopes: "openid offline_access samples:read",
  appUrl: "http://localhost:8787",
  port: 8787,
  sessionSecret: "session-secret-for-tests",
  testHooks: false,
};

type TokenReply = { status: number; body: Record<string, unknown> };

export class FakeWallet {
  /** Every form posted to the token endpoint. */
  tokenRequests: URLSearchParams[] = [];
  /** Bearer tokens sent to the MCP endpoint. */
  mcpTokens: string[] = [];
  samples: Sample[] = [];
  /** Access tokens the MCP endpoint answers 401 for. */
  rejectedTokens = new Set<string>();
  /** Next replies of the token endpoint; when empty a fresh token is issued. */
  tokenReplies: TokenReply[] = [];
  /** Access tokens issued so far, in order. */
  issued: string[] = [];
  /** Tool result override, e.g. an `isError` result. */
  toolResult: Record<string, unknown> | undefined;
  #counter = 0;

  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        jwks_uri: `${ISSUER}/oauth2/jwks`,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    }
    if (url.href === `${ISSUER}/oauth2/token` && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      this.tokenRequests.push(form);
      const reply = this.tokenReplies.shift();
      if (reply) return json(reply.status, reply.body);
      return json(200, this.issueTokens());
    }
    if (url.href === MCP_URL) return this.#mcp(request);
    throw new Error(`Unexpected request: ${request.method} ${url.href}`);
  };

  /** Like AuthKit: no `scope` in the response, it is a claim of the access token. */
  issueTokens(scope = "openid offline_access samples:read scores:read") {
    const n = ++this.#counter;
    const now = Math.floor(Date.now() / 1000);
    const accessToken = fakeJwt({ iss: ISSUER, aud: MCP_URL, sub: "user_1", scope, jti: `${n}` });
    this.issued.push(accessToken);
    return {
      token_type: "bearer",
      access_token: accessToken,
      refresh_token: `refresh-${n}`,
      expires_in: 900,
      id_token: fakeJwt({
        iss: ISSUER,
        aud: config.clientId,
        sub: "user_1",
        email: "pat@example.com",
        iat: now,
        exp: now + 900,
      }),
    };
  }

  async #mcp(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    this.mcpTokens.push(token);
    if (this.rejectedTokens.has(token)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
      });
    }
    const message = (await request.json()) as { id?: number; method: string; params?: unknown };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      const { protocolVersion } = message.params as { protocolVersion: string };
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-wallet", version: "0" },
        },
      });
    }
    if (message.method === "tools/call") {
      const result = this.toolResult ?? {
        content: [{ type: "text", text: JSON.stringify(this.samples) }],
        structuredContent: { result: this.samples },
        isError: false,
      };
      return json(200, { jsonrpc: "2.0", id: message.id, result });
    }
    return json(200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
}

export const sample = (n: number): Sample => ({
  sample_id: `sample_${n}`,
  label: `Sample #${n}`,
  source_filename: `genome_${n}.txt`,
  file_size: 1024,
  processed_at: "2026-10-01T12:00:00Z",
  provenance: null,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A JWT with a fake signature. Nothing here verifies token signatures. */
function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(payload)}.c2lnbmF0dXJl`;
}
