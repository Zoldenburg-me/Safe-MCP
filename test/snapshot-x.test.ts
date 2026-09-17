import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  chainShortName,
  encodeCancel,
  FINALIZATION_STATUS,
  parseSpaceRef,
  PROPOSAL_STATUS,
} from "../src/platforms/snapshotX.js";

const SPACE = "0x594EB60b35C4E91A06a5df988e0504f7463cB769";

describe("Snapshot X cancel calldata", () => {
  it("matches the calldata a Safe co-signer verifies by hand", () => {
    // The exact bytes from the SC DAO veto checklist for proposal #3.
    assert.equal(
      encodeCancel(3),
      "0x40e58ee50000000000000000000000000000000000000000000000000000000000000003"
    );
  });

  it("uses the cancel(uint256) selector for every id form", () => {
    for (const id of [1, "1", 1n]) {
      assert.equal(encodeCancel(id).slice(0, 10), "0x40e58ee5");
    }
    assert.equal(encodeCancel("42"), encodeCancel(42));
  });
});

describe("Snapshot X space references", () => {
  it("accepts a bare space contract address", () => {
    const ref = parseSpaceRef(SPACE.toLowerCase());
    assert.equal(ref.space, SPACE);
    assert.equal(ref.chainId, undefined);
    assert.equal(ref.proposalId, undefined);
  });

  it("resolves the network prefix of a space id", () => {
    const ref = parseSpaceRef(`eth:${SPACE}`);
    assert.equal(ref.space, SPACE);
    assert.equal(ref.chainId, 1);

    assert.equal(parseSpaceRef(`sep:${SPACE}`).chainId, 11_155_111);
    assert.equal(parseSpaceRef(`base:${SPACE}`).chainId, 8453);
  });

  it("takes space, network and proposal id from a snapshot.box URL", () => {
    const ref = parseSpaceRef(`https://snapshot.box/#/eth:${SPACE}/proposal/3`);
    assert.equal(ref.space, SPACE);
    assert.equal(ref.chainId, 1);
    assert.equal(ref.proposalId, "3");
  });

  it("rejects an unknown network prefix by name", () => {
    assert.throws(() => parseSpaceRef(`nope:${SPACE}`), /Unknown network prefix "nope"/);
  });

  it("rejects an off-chain Snapshot space id and says why", () => {
    assert.throws(() => parseSpaceRef("ens.eth"), /Off-chain Snapshot spaces/);
    assert.throws(
      () => parseSpaceRef("https://snapshot.box/#/s:ens.eth/proposal/0xabc"),
      /not a Snapshot X space/
    );
  });

  it("round-trips chain ids back to app.safe.global short names", () => {
    assert.equal(chainShortName(1), "eth");
    assert.equal(chainShortName(11_155_111), "sep");
    assert.equal(chainShortName(424_242), undefined);
  });
});

describe("Snapshot X status labels", () => {
  it("keeps the sx-evm enum order", () => {
    assert.deepEqual([...FINALIZATION_STATUS], ["Pending", "Executed", "Cancelled"]);
    assert.equal(PROPOSAL_STATUS[6], "Cancelled");
    assert.equal(PROPOSAL_STATUS[1], "VotingPeriod");
  });
});
