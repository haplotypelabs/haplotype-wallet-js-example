// Reading the user's data: Haplotype Wallet exposes it as MCP tools at
// WALLET_MCP_URL. We call them with the official MCP TypeScript SDK over
// Streamable HTTP, with the access token as a bearer token. The endpoint is
// stateless, so each page load opens a short-lived client and closes it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ListSamplesResult, type Sample, TOOLS } from "./contract.ts";

/** The MCP endpoint answered 401: the access token is expired or revoked. */
export class AccessTokenRejectedError extends Error {}

/** The tool ran and reported an error, e.g. a missing permission. */
export class ToolError extends Error {}

export async function listSamples(
  mcpUrl: string,
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<Sample[]> {
  const result = await callTool(mcpUrl, accessToken, TOOLS.listSamples, {}, fetchImpl);
  // The list is in `structuredContent.result`.
  const samples = (result as Partial<ListSamplesResult> | undefined)?.result;
  if (!Array.isArray(samples)) throw new Error(`Unexpected ${TOOLS.listSamples} result.`);
  return samples;
}

async function callTool(
  mcpUrl: string,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: fetchImpl,
  });
  const client = new Client({ name: "haplotype-wallet-js-example", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : ""))
        .join(" ")
        .trim();
      throw new ToolError(text || `${name} failed.`);
    }
    return result.structuredContent;
  } catch (err) {
    if (err instanceof StreamableHTTPError && err.code === 401) {
      throw new AccessTokenRejectedError("Haplotype Wallet rejected the access token.");
    }
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}
