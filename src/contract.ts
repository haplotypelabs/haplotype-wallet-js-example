// Everything this app takes from the Haplotype Wallet contract: environments,
// scopes and their consent wording, tool names, and tool result types.
// Data only, no logic, so the file can be swapped for a newer version as is.
// Reference: https://www.haplotype.ai/developers/

export const WALLET_ENVIRONMENTS = {
  production: {
    issuer: "https://authkit.haplotype.ai",
    mcpUrl: "https://api.haplotype.ai/mcp",
  },
  stage: {
    issuer: "https://great-countryside-82-staging.authkit.app",
    mcpUrl: "https://api.stage.haplotype.ai/mcp",
  },
} as const;

/** Wallet scopes, with the sentence the wallet's consent screen shows for each. */
export const WALLET_SCOPES: Readonly<Record<string, string>> = {
  "samples:read": "See which genotype files you have and how they were processed",
  "variants:read": "Read your genotype at the positions it asks about",
  "scores:read": "Read your polygenic scores and analysis runs",
  "runs:write": "Start new analyses on your genotypes",
};

/** Standard OpenID Connect scopes. They concern sign-in, not wallet data. */
export const OIDC_SCOPES: readonly string[] = ["openid", "profile", "email", "offline_access"];

/** MCP tools this app calls. */
export const TOOLS = {
  listSamples: "list_samples",
} as const;

/** One step of the processing pipeline that produced a sample. */
export interface PipelineStep {
  step: string | null;
  /** Tools the step ran, each as "name version". */
  tools: string[];
  started_at: string | null;
  finished_at: string | null;
}

/** How a sample was produced, and the uploaded file it came from. */
export interface Provenance {
  is_imputed: boolean | null;
  source_build: string | null;
  target_build: string | null;
  reference_panel: string | null;
  variant_count: number | null;
  impute_reason: string | null;
  processed_at: string | null;
  imputation_tool: string | null;
  pipeline: PipelineStep[];
  source_upload: { filename: string; uploaded_at: string };
}

/** A sample the caller is authorized to use, as returned by `list_samples`. */
export interface Sample {
  sample_id: string;
  /** Short display name, e.g. "Sample #1". */
  label: string;
  source_filename: string;
  /** Size of the uploaded file in bytes. */
  file_size: number;
  processed_at: string;
  haplohub_created?: string | null;
  /** Null for samples processed before provenance was recorded. */
  provenance?: Provenance | null;
}

/** `structuredContent` of a `list_samples` call. */
export interface ListSamplesResult {
  result: Sample[];
}
