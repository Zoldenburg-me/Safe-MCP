import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { hashTypedData } from "viem";
import {
  buildVoteTypedData,
  type SnapshotProposalType,
} from "../src/platforms/snapshot.js";

/**
 * The Safe SDK signs the hash viem derives; the Snapshot hub re-derives it with
 * ethers' _TypedDataEncoder before checking the Safe's EIP-1271 signature. If
 * the two ever disagree, every vote is silently rejected at the hub, so this is
 * the invariant most worth pinning down.
 */
const CASES: Array<{
  type: SnapshotProposalType;
  choices: string[];
  choice: number | number[] | Record<string, number>;
}> = [
  { type: "single-choice", choices: ["For", "Against", "Abstain"], choice: 1 },
  { type: "basic", choices: ["For", "Against", "Abstain"], choice: 2 },
  { type: "approval", choices: ["A", "B", "C"], choice: [1, 3] },
  { type: "ranked-choice", choices: ["A", "B", "C"], choice: [3, 1, 2] },
  { type: "weighted", choices: ["A", "B"], choice: { 1: 70, 2: 30 } },
  { type: "quadratic", choices: ["A", "B"], choice: { 1: 1, 2: 1 } },
];

describe("EIP-712 hash agreement between the Safe SDK and the Snapshot hub", () => {
  for (const testCase of CASES) {
    it(`agrees for ${testCase.type}`, () => {
      const typedData = buildVoteTypedData({
        safeAddress: "0x1234567890123456789012345678901234567890",
        space: "ens.eth",
        proposalId: `0x${"ab".repeat(32)}`,
        proposalType: testCase.type,
        choices: testCase.choices,
        choice: testCase.choice,
        reason: "Testing hash agreement.",
        app: "safe-mpc",
      });

      const safeSdkHash = hashTypedData(typedData);
      const hubHash = _TypedDataEncoder.hash(
        typedData.domain,
        typedData.types,
        typedData.message
      );

      assert.equal(safeSdkHash, hubHash);
    });
  }

  it("would break if EIP712Domain were added to types", () => {
    const typedData = buildVoteTypedData({
      safeAddress: "0x1234567890123456789012345678901234567890",
      space: "ens.eth",
      proposalId: `0x${"ab".repeat(32)}`,
      proposalType: "single-choice",
      choices: ["For", "Against"],
      choice: 1,
      reason: "",
      app: "safe-mpc",
    });

    const withDomain = {
      ...typedData.types,
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
      ],
    };

    // ethers treats two unreferenced roots as ambiguous, which is why the vote
    // payload must carry only the Vote type.
    assert.throws(
      () => _TypedDataEncoder.hash(typedData.domain, withDomain, typedData.message),
      /ambiguous primary types|unused types/
    );
  });
});
