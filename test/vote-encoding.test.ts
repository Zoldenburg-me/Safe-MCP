import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { encodeChoice, buildVoteTypedData } from "../src/platforms/snapshot.js";
import { encodeCastVote, supportToUint8 } from "../src/platforms/governor.js";
import { assertGovernorAllowed, assertSpaceAllowed, type Config } from "../src/config.js";

const CHOICES = ["For", "Against", "Abstain"];

describe("Snapshot choice encoding", () => {
  it("passes a 1-indexed integer through for single-choice and basic", () => {
    for (const type of ["single-choice", "basic"] as const) {
      const { choice, types } = encodeChoice(type, CHOICES, 2);
      assert.equal(choice, 2);
      assert.equal(types.Vote.find((f) => f.name === "choice")?.type, "uint32");
    }
  });

  it("rejects a choice index outside the proposal's options", () => {
    assert.throws(() => encodeChoice("single-choice", CHOICES, 4), /between 1 and 3/);
    assert.throws(() => encodeChoice("single-choice", CHOICES, 0), /between 1 and 3/);
  });

  it("rejects an array where a single choice is required", () => {
    assert.throws(() => encodeChoice("single-choice", CHOICES, [1]), /single integer/);
  });

  it("uses uint32[] for approval and accepts a subset", () => {
    const { choice, types } = encodeChoice("approval", CHOICES, [1, 3]);
    assert.deepEqual(choice, [1, 3]);
    assert.equal(types.Vote.find((f) => f.name === "choice")?.type, "uint32[]");
  });

  it("rejects duplicate options in an array choice", () => {
    assert.throws(() => encodeChoice("approval", CHOICES, [1, 1]), /same option twice/);
  });

  it("requires every option to be ranked for ranked-choice", () => {
    assert.throws(() => encodeChoice("ranked-choice", CHOICES, [1, 2]), /all 3 options/);
    assert.deepEqual(encodeChoice("ranked-choice", CHOICES, [3, 1, 2]).choice, [3, 1, 2]);
  });

  it("serialises weighted and quadratic choices as a JSON string", () => {
    for (const type of ["weighted", "quadratic"] as const) {
      const { choice, types } = encodeChoice(type, CHOICES, { 1: 70, 2: 30 });
      assert.equal(choice, '{"1":70,"2":30}');
      assert.equal(types.Vote.find((f) => f.name === "choice")?.type, "string");
    }
  });

  it("rejects weighted options out of range or with a non-positive weight", () => {
    assert.throws(() => encodeChoice("weighted", CHOICES, { 9: 10 }), /out of range/);
    assert.throws(() => encodeChoice("weighted", CHOICES, { 1: 0 }), /positive number/);
  });
});

describe("Snapshot vote payload", () => {
  const typedData = buildVoteTypedData({
    safeAddress: "0x1234567890123456789012345678901234567890",
    space: "ens.eth",
    proposalId: `0x${"ab".repeat(32)}`,
    proposalType: "single-choice",
    choices: CHOICES,
    choice: 1,
    reason: "Because.",
    app: "safe-mpc",
  });

  it("uses the snapshot domain the hub expects", () => {
    assert.deepEqual(typedData.domain, { name: "snapshot", version: "0.1.4" });
    assert.equal(typedData.primaryType, "Vote");
  });

  it("omits EIP712Domain from types, which ethers rejects as ambiguous", () => {
    assert.deepEqual(Object.keys(typedData.types), ["Vote"]);
  });

  it("keeps the canonical field order from snapshot.js", () => {
    assert.deepEqual(
      typedData.types.Vote.map((f) => f.name),
      ["from", "space", "timestamp", "proposal", "choice", "reason", "app", "metadata"]
    );
  });

  it("votes as the Safe, not the agent signer", () => {
    assert.equal(typedData.message.from, "0x1234567890123456789012345678901234567890");
    assert.equal(typedData.message.metadata, "{}");
    assert.ok(typedData.message.timestamp > 1_700_000_000);
  });
});

describe("Governor calldata", () => {
  const proposalId = "42";

  it("maps support labels to GovernorCountingSimple values", () => {
    assert.equal(supportToUint8("against"), 0);
    assert.equal(supportToUint8("for"), 1);
    assert.equal(supportToUint8("abstain"), 2);
  });

  it("encodes castVoteWithReason when a reason is given", () => {
    const data = encodeCastVote({ proposalId, support: "for", reason: "Sound budget." });
    // selector of castVoteWithReason(uint256,uint8,string)
    assert.equal(data.slice(0, 10), "0x7b3c71d3");
    // proposalId 42 and support 1 in the first two words
    assert.equal(data.slice(10, 74), "42".padStart(64, "0").replace("42", "2a"));
    assert.equal(data.slice(74, 138), "1".padStart(64, "0"));
  });

  it("falls back to castVote when the reason is empty", () => {
    const data = encodeCastVote({ proposalId, support: "against", reason: "" });
    // selector of castVote(uint256,uint8)
    assert.equal(data.slice(0, 10), "0x56781388");
    // against == 0
    assert.equal(data.slice(74, 138), "0".padStart(64, "0"));
  });

  it("accepts a hex proposal id as well as decimal", () => {
    const fromHex = encodeCastVote({ proposalId: "0x2a", support: "for", reason: "" });
    const fromDec = encodeCastVote({ proposalId: "42", support: "for", reason: "" });
    assert.equal(fromHex, fromDec);
  });
});

describe("Allowlist guards", () => {
  const base = { ALLOWED_SNAPSHOT_SPACES: [], ALLOWED_GOVERNORS: [] } as unknown as Config;

  it("allows anything when the allowlist is empty", () => {
    assert.doesNotThrow(() => assertSpaceAllowed(base, "ens.eth"));
    assert.doesNotThrow(() => assertGovernorAllowed(base, "0xabc"));
  });

  it("permits a listed space regardless of case", () => {
    const config = { ...base, ALLOWED_SNAPSHOT_SPACES: ["ens.eth"] } as Config;
    assert.doesNotThrow(() => assertSpaceAllowed(config, "ENS.eth"));
  });

  it("refuses an unlisted space", () => {
    const config = { ...base, ALLOWED_SNAPSHOT_SPACES: ["ens.eth"] } as Config;
    assert.throws(() => assertSpaceAllowed(config, "other.eth"), /not in ALLOWED_SNAPSHOT_SPACES/);
  });

  it("refuses an unlisted governor", () => {
    const config = { ...base, ALLOWED_GOVERNORS: ["0xaaa"] } as Config;
    assert.throws(() => assertGovernorAllowed(config, "0xbbb"), /not in ALLOWED_GOVERNORS/);
  });
});
