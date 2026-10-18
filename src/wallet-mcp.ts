// Reading the user's data: Haplotype Wallet exposes it as MCP tools at
// WALLET_MCP_URL. We call them with the official MCP TypeScript SDK over
// Streamable HTTP, with the access token as a bearer token. The endpoint is
// stateless, so each page load opens a short-lived client and closes it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ERROR_CODES,
  ERROR_META_KEY,
  type ListSamplesResult,
  type Sample,
  TOOLS,
  type WalletErrorCode,
} from "./contract.ts";

/** The MCP endpoint answered 401: the access token is expired or revoked. */
export class AccessTokenRejectedError extends Error {}

/**
 * What the wallet says about a failed tool call, in `result._meta`. Act on
 * `code`, not on the message: the message is written for AI assistants.
 */
export interface WalletErrorInfo {
  code: WalletErrorCode;
  /** True when the same call can succeed later without changes. */
  retryable: boolean;
  /** Error reference. Quote it when you contact Haplotype Labs. */
  ref?: string;
  /** With `missing_scope`: the scope the tool needs. */
  scope?: string;
  /** With a billing code: where the user manages their plan. */
  manageUrl?: string;
}

/** The tool ran and reported an error, e.g. a missing permission. */
export class ToolError extends Error {
  readonly info: WalletErrorInfo;
  constructor(message: string, info: WalletErrorInfo) {
    super(message);
    this.info = info;
  }
}

/**
 * The error envelope of a failed call. A code this app does not know (the
 * wallet may add some) is treated as `internal_error`, as the docs ask.
 */
export function errorInfo(meta: unknown): WalletErrorInfo {
  const raw = (meta as Record<string, unknown> | undefined)?.[ERROR_META_KEY] as
    Record<string, unknown> | undefined;
  const code = typeof raw?.code === "string" && raw.code in ERROR_CODES ? raw.code : null;
  const text = (key: string) => (typeof raw?.[key] === "string" ? raw[key] : undefined);
  if (!code) return { code: "internal_error", retryable: false, ref: text("ref") };
  return {
    code: code as WalletErrorCode,
    retryable: ERROR_CODES[code as WalletErrorCode].retryable,
    ref: text("ref"),
    scope: text("scope"),
    manageUrl: text("manage_url"),
  };
}

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
      throw new ToolError(text || `${name} failed.`, errorInfo(result._meta));
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
