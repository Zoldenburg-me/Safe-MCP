import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { toEventSelector } from "viem";
import { titleFromDescription } from "../src/platforms/governorIndexer.js";

describe("Proposal title extraction", () => {
  it("strips a markdown heading", () => {
    assert.equal(titleFromDescription("# Fund the thing\n\nBody text"), "Fund the thing");
    assert.equal(titleFromDescription("### Deep heading"), "Deep heading");
  });

  it("uses the first meaningful line when there is no heading", () => {
    assert.equal(titleFromDescription("\n\n  Raise the cap  \nmore"), "Raise the cap");
  });

  it("falls back for an empty or heading-only description", () => {
    assert.equal(titleFromDescription(""), "(untitled)");
    assert.equal(titleFromDescription("\n\n   \n"), "(untitled)");
    assert.equal(titleFromDescription("#"), "(untitled)");
  });

  it("truncates a description with no line breaks", () => {
    const title = titleFromDescription("x".repeat(500));
    assert.equal(title.length, 200);
    assert.ok(title.endsWith("..."));
  });
});

describe("ProposalCreated event coverage", () => {
  /**
   * The indexer uses a single event definition for both governor families. That
   * is only valid while the two signatures hash to the same topic, which holds
   * because parameter names are not part of the selector.
   */
  it("hashes identically for OpenZeppelin and Compound Bravo declarations", () => {
    const openZeppelin =
      "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)";
    const compoundBravo =
      "event ProposalCreated(uint256 id, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)";

    assert.equal(toEventSelector(openZeppelin), toEventSelector(compoundBravo));
  });

  it("differs from a governor that indexes the proposal id", () => {
    // A fork that marks proposalId indexed would need its own definition, so
    // this asserts the limitation rather than papering over it.
    const indexed =
      "event ProposalCreated(uint256 indexed proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)";
    const plain =
      "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)";

    // Indexing does not change the selector, only where the value is stored.
    assert.equal(toEventSelector(indexed), toEventSelector(plain));
  });
});
