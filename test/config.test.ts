import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const required = { WALLET_CLIENT_ID: "id", WALLET_CLIENT_SECRET: "secret", SESSION_SECRET: "s" };

describe("loadConfig", () => {
  it("uses production defaults and keeps test hooks off", () => {
    const config = loadConfig(required);
    expect(config.walletIssuer.href).toBe("https://authkit.haplotype.ai/");
    expect(config.walletMcpUrl).toBe("https://api.haplotype.ai/mcp");
    expect(config.scopes).toBe("openid offline_access samples:read");
    expect(config.appUrl).toBe("http://localhost:8787");
    expect(config.port).toBe(8787);
    expect(config.testHooks).toBe(false);
  });

  it("turns test hooks on only for EXAMPLE_TEST_HOOKS=1", () => {
    expect(loadConfig({ ...required, EXAMPLE_TEST_HOOKS: "1" }).testHooks).toBe(true);
    expect(loadConfig({ ...required, EXAMPLE_TEST_HOOKS: "true" }).testHooks).toBe(false);
  });

  it("names missing required variables", () => {
    expect(() => loadConfig({})).toThrow(/WALLET_CLIENT_ID, WALLET_CLIENT_SECRET, SESSION_SECRET/);
  });
});
