// Generates src/contract.ts from contract/connect-contract.json, the Connect
// contract Haplotype Wallet publishes at
// https://www.haplotype.ai/developers/connect-contract.json.
//
//   pnpm contract:generate           write src/contract.ts
//   pnpm contract:generate --check   fail if src/contract.ts is out of date
//
// Only the tools listed in APP_TOOLS end up in the module, with result types
// generated from their `output_schema`.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import * as prettier from "prettier";

type JSONSchema = Parameters<typeof compile>[0];

const CONTRACT_FILE = "contract/connect-contract.json";
const OUTPUT_FILE = "src/contract.ts";

/** Contract shapes this generator understands. */
const SUPPORTED_CONTRACT_VERSIONS = [1];

/**
 * MCP tools this app calls. `types` names subschemas of the tool's
 * `output_schema` (by JSON pointer) so they become their own interfaces.
 */
const APP_TOOLS: Record<
  string,
  { tool: string; resultType: string; types: Record<string, string> }
> = {
  listSamples: {
    tool: "list_samples",
    resultType: "ListSamplesResult",
    types: {
      "/properties/result/items": "Sample",
      "/properties/result/items/properties/provenance/anyOf/0": "Provenance",
      "/properties/result/items/properties/provenance/anyOf/0/properties/pipeline/items":
        "PipelineStep",
    },
  },
};

interface ConnectContract {
  contract_version: number;
  oauth: {
    issuer: string;
    authorize_path: string;
    token_path: string;
    resource: string;
    resource_required_on: string[];
    access_token_lifetime_seconds: number;
  };
  mcp: { url: string; stateless: boolean };
  scopes: { slug: string; name: string; description: string; tools: string[] }[];
  open_tools: string[];
  tools: { name: string; scope: string; input_schema: JSONSchema; output_schema: JSONSchema }[];
  /** Added to contract_version 1 later, so older copies lack it. */
  errors?: {
    meta_key: string;
    codes: { code: string; retryable: boolean; meaning: string; action: string }[];
  };
}

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

function parseContract(raw: string): ConnectContract {
  const data: unknown = JSON.parse(raw);
  const version = (data as { contract_version?: unknown } | null)?.contract_version;
  if (typeof version !== "number") {
    throw new Error(`${CONTRACT_FILE} has no contract_version. Is it a Connect contract?`);
  }
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(version)) {
    throw new Error(
      `${CONTRACT_FILE} has contract_version ${version}, but this generator supports ` +
        `${SUPPORTED_CONTRACT_VERSIONS.join(", ")}. The contract's shape changed: update ` +
        `scripts/generate-contract.ts for it before regenerating.`,
    );
  }
  if (!(data as ConnectContract).errors) {
    throw new Error(
      `${CONTRACT_FILE} has no \`errors\`, which this app needs to act on tool errors. ` +
        `It is older than the wallet release that added error codes.`,
    );
  }
  return data as ConnectContract;
}

function schemaAt(schema: JSONSchema, pointer: string, tool: string): Record<string, unknown> {
  let node: unknown = schema;
  for (const key of pointer.split("/").slice(1)) {
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`The output_schema of ${tool} has no object schema at ${pointer}.`);
  }
  return node as Record<string, unknown>;
}

async function resultTypes(contract: ConnectContract): Promise<string> {
  const out: string[] = [];
  for (const { tool, resultType, types } of Object.values(APP_TOOLS)) {
    const spec = contract.tools.find((t) => t.name === tool);
    if (!spec) throw new Error(`The contract has no tool ${tool}, which this app calls.`);
    const schema = structuredClone(spec.output_schema);
    for (const [pointer, name] of Object.entries(types)) {
      schemaAt(schema, pointer, tool).title = name;
    }
    schema.description ??= `\`structuredContent\` of a \`${tool}\` call.`;
    out.push(
      await compile(schema, resultType, {
        bannerComment: "",
        additionalProperties: false,
        format: false,
        unknownAny: true,
        strictIndexSignatures: true,
      }),
    );
  }
  // json-schema-to-typescript puts no blank line between declarations.
  return out.join("\n").replace(/^}\n(?=\S)/gm, "}\n\n");
}

async function render(raw: string): Promise<string> {
  const contract = parseContract(raw);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const tools = Object.fromEntries(Object.entries(APP_TOOLS).map(([key, t]) => [key, t.tool]));
  const errors = contract.errors!;

  const source = `// Generated by scripts/generate-contract.ts from ${CONTRACT_FILE}
// (contract_version ${contract.contract_version}, sha256 ${sha256}).
// Do not edit. Run \`pnpm contract:generate\` instead.
//
// Everything this app takes from the Haplotype Wallet contract. Production
// values only: for staging, set WALLET_ISSUER and WALLET_MCP_URL.
// Reference: https://www.haplotype.ai/developers/

export const CONTRACT_VERSION = ${contract.contract_version};

/** The production wallet's authorization server. */
export const WALLET_OAUTH = {
  issuer: ${json(contract.oauth.issuer)},
  authorizePath: ${json(contract.oauth.authorize_path)},
  tokenPath: ${json(contract.oauth.token_path)},
  /** The token audience. Send it as \`resource\` on each request in \`resourceRequiredOn\`. */
  resource: ${json(contract.oauth.resource)},
  resourceRequiredOn: ${json(contract.oauth.resource_required_on)},
  accessTokenLifetimeSeconds: ${contract.oauth.access_token_lifetime_seconds},
} as const;

/** The production MCP endpoint. Stateless: a call needs no session. */
export const WALLET_MCP = {
  url: ${json(contract.mcp.url)},
  stateless: ${contract.mcp.stateless},
} as const;

export interface WalletScope {
  slug: string;
  /** Short name of the permission. */
  name: string;
  /** The sentence the wallet's consent screen shows. */
  description: string;
}

/** Wallet scopes, in consent-screen order. */
export const WALLET_SCOPES: readonly WalletScope[] = ${json(
    contract.scopes.map(({ slug, name, description }) => ({ slug, name, description })),
  )};

/** MCP tools this app calls. */
export const TOOLS = ${json(tools)} as const;

/** A failed tool call carries its error in \`result._meta[ERROR_META_KEY]\`. */
export const ERROR_META_KEY = ${json(errors.meta_key)};

/** Every error code the wallet sends, and whether retrying the same call can help. */
export const ERROR_CODES = ${json(
    Object.fromEntries(errors.codes.map(({ code, retryable }) => [code, { retryable }])),
  )} as const;

export type WalletErrorCode = keyof typeof ERROR_CODES;

${await resultTypes(contract)}`;

  const output = root(OUTPUT_FILE);
  const options = await prettier.resolveConfig(output);
  return prettier.format(source, { ...options, filepath: output });
}

async function main() {
  const check = process.argv.includes("--check");
  const generated = await render(await readFile(root(CONTRACT_FILE), "utf8"));
  if (!check) {
    await writeFile(root(OUTPUT_FILE), generated);
    console.log(`Wrote ${OUTPUT_FILE}.`);
    return;
  }
  const current = await readFile(root(OUTPUT_FILE), "utf8").catch(() => "");
  if (current !== generated) {
    console.error(
      `${OUTPUT_FILE} does not match ${CONTRACT_FILE}. Run \`pnpm contract:generate\`.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
