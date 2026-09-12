import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseDotEnv } from "../src/dotenv.js";

describe("Env file parsing", () => {
  it("reads plain key=value pairs", () => {
    assert.deepEqual(parseDotEnv("SAFE_CHAIN_ID=1\nDRY_RUN=true"), {
      SAFE_CHAIN_ID: "1",
      DRY_RUN: "true",
    });
  });

  it("ignores comments and blank lines", () => {
    assert.deepEqual(parseDotEnv("# a comment\n\n  \nA=1\n"), { A: "1" });
  });

  it("strips matching surrounding quotes", () => {
    assert.deepEqual(parseDotEnv(`A="one two"\nB='three'`), {
      A: "one two",
      B: "three",
    });
  });

  it("keeps a value containing an equals sign intact", () => {
    // Base64 keys and RPC URLs with query strings both hit this.
    assert.deepEqual(parseDotEnv("KEY=abc=def==\nURL=https://x.example/rpc?k=v"), {
      KEY: "abc=def==",
      URL: "https://x.example/rpc?k=v",
    });
  });

  it("keeps an unbalanced quote rather than trimming one side", () => {
    assert.deepEqual(parseDotEnv(`A="unterminated`), { A: '"unterminated' });
  });

  it("skips lines with no key", () => {
    assert.deepEqual(parseDotEnv("=novalue\nnoequals\nA=1"), { A: "1" });
  });

  it("trims whitespace around keys and values", () => {
    assert.deepEqual(parseDotEnv("  A  =  1  "), { A: "1" });
  });
});
