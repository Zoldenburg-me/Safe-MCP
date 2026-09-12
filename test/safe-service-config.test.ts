import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertSafeServiceConfigured } from "../src/safe.js";
import type { Config } from "../src/config.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    SAFE_ADDRESS: "0x0000000000000000000000000000000000000001",
    SAFE_AGENT_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    SAFE_CHAIN_ID: 1,
    ...overrides,
  } as Config;
}

describe("Safe service configuration", () => {
  it("refuses a config with neither an API key nor a service URL", () => {
    assert.throws(() => assertSafeServiceConfigured(config()), /SAFE_API_KEY is not set/);
  });

  it("names the tools that would otherwise fail on first use", () => {
    // The whole point is that the operator learns this at startup, not on the
    // agent's first vote, so the message has to say what breaks.
    assert.throws(() => assertSafeServiceConfigured(config()), /safe_info.*governor_vote/s);
  });

  it("accepts an API key", () => {
    assertSafeServiceConfigured(config({ SAFE_API_KEY: "key" }));
  });

  it("accepts a self-hosted service URL without a key", () => {
    // A non-Safe-domain txServiceUrl satisfies the SDK constructor on its own.
    assertSafeServiceConfigured(config({ SAFE_TX_SERVICE_URL: "https://safe-tx.internal/api" }));
  });
});
