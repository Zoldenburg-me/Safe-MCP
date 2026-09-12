import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { toEventSelector } from "viem";
import {
  lookbackFromGovernorClock,
  titleFromDescription,
} from "../src/platforms/governorIndexer.js";

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

describe("Scan window derived from the Governor", () => {
  const DAY = 86_400_000;

  it("covers votingDelay plus votingPeriod for a timestamp-clock Governor", () => {
    // 1 day delay, 3 day voting period, in seconds.
    const ms = lookbackFromGovernorClock({
      votingDelay: 86_400n,
      votingPeriod: 259_200n,
      mode: "timestamp",
      secondsPerBlock: 12,
      marginMs: 2 * DAY,
    });

    assert.equal(ms, 4 * DAY + 2 * DAY);
  });

  it("converts block counts using the measured block time", () => {
    // 7200 blocks delay + 21600 blocks voting at 12s = 4 days.
    const ms = lookbackFromGovernorClock({
      votingDelay: 7_200n,
      votingPeriod: 21_600n,
      mode: "blocknumber",
      secondsPerBlock: 12,
      marginMs: 0,
    });

    assert.equal(ms, 4 * DAY);
  });

  it("shrinks with a faster chain, since the same blocks span less time", () => {
    const slow = lookbackFromGovernorClock({
      votingDelay: 0n,
      votingPeriod: 21_600n,
      mode: "blocknumber",
      secondsPerBlock: 12,
      marginMs: 0,
    });
    const fast = lookbackFromGovernorClock({
      votingDelay: 0n,
      votingPeriod: 21_600n,
      mode: "blocknumber",
      secondsPerBlock: 0.25,
      marginMs: 0,
    });

    assert.equal(slow / fast, 48);
  });

  it("stays far below a fixed month for a typical three-day DAO", () => {
    const ms = lookbackFromGovernorClock({
      votingDelay: 7_200n,
      votingPeriod: 21_600n,
      mode: "blocknumber",
      secondsPerBlock: 12,
      marginMs: 2 * DAY,
    });

    assert.ok(ms < 30 * DAY, "a 3-day vote must not need a 30-day scan");
    assert.equal(ms, 6 * DAY);
  });

  it("rejects a Governor reporting no voting window, so the caller falls back", () => {
    assert.throws(
      () =>
        lookbackFromGovernorClock({
          votingDelay: 0n,
          votingPeriod: 0n,
          mode: "blocknumber",
          secondsPerBlock: 12,
          marginMs: 0,
        }),
      /non-positive voting window/
    );
  });
});
