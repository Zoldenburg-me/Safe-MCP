import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Interface } from "ethers";
import { decodeFunctionData, toFunctionSelector, type Address } from "viem";
import {
  activeStrategyIndices,
  CHOICE_VALUE,
  chainShortName,
  DEFAULT_ETH_TX_AUTHENTICATOR,
  encodeCancel,
  encodeEthTxVote,
  encodeSpaceVote,
  ETH_TX_AUTHENTICATOR_ABI,
  pinReason,
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

const SAFE = "0x1111111111111111111111111111111111111111" as Address;

describe("Snapshot X vote calldata", () => {
  const vote = {
    space: SPACE as Address,
    voter: SAFE,
    proposalId: 7,
    choice: "for" as const,
    strategies: [
      { index: 0, params: "0x00" as const },
      { index: 2, params: "0x00" as const },
    ],
    metadataUri: "ipfs://bafkreitest",
  };

  it("targets the selector the EthTx authenticator whitelists", () => {
    // Authenticator.sol: VOTE_SELECTOR = keccak256("vote(address,uint256,uint8,(uint8,bytes)[],string)")
    assert.equal(
      encodeSpaceVote(vote).slice(0, 10),
      toFunctionSelector("vote(address,uint256,uint8,(uint8,bytes)[],string)")
    );
  });

  it("matches the authenticate() call sx.js builds for an EthTx vote", () => {
    // Mirrors sx.js EthereumTx.vote: encode Space.vote with ethers, split off
    // the selector, and pass (space, selector, args) to authenticate.
    const space = new Interface([
      "function vote(address voter, uint256 proposalId, uint8 choice, tuple(uint8 index, bytes params)[] userVotingStrategies, string metadataURI)",
    ]);
    const functionData = space.encodeFunctionData("vote", [
      SAFE,
      7,
      1,
      [
        { index: 0, params: "0x00" },
        { index: 2, params: "0x00" },
      ],
      "ipfs://bafkreitest",
    ]);
    const auth = new Interface([
      "function authenticate(address target, bytes4 functionSelector, bytes data)",
    ]);
    const expected = auth.encodeFunctionData("authenticate", [
      SPACE,
      functionData.slice(0, 10),
      `0x${functionData.slice(10)}`,
    ]);

    assert.equal(encodeEthTxVote(vote), expected);
  });

  it("forwards the Safe as voter, so EthTxAuthenticator accepts it from the Safe", () => {
    const { functionName, args } = decodeFunctionData({
      abi: ETH_TX_AUTHENTICATOR_ABI,
      data: encodeEthTxVote(vote),
    });
    assert.equal(functionName, "authenticate");
    assert.equal(args[0], SPACE);
    // The first argument word of the forwarded vote is the voter.
    assert.equal(args[2].slice(0, 66).toLowerCase(), `0x${SAFE.slice(2).padStart(64, "0")}`);
  });

  it("uses the sx-evm Choice order, which is not the Governor's", () => {
    assert.deepEqual(CHOICE_VALUE, { against: 0, for: 1, abstain: 2 });
  });

  it("defaults to the snapshot.box EthTx authenticator", () => {
    assert.equal(DEFAULT_ETH_TX_AUTHENTICATOR, "0xBA06E6cCb877C332181A6867c05c8b746A21Aed1");
  });
});

describe("Snapshot X active strategies", () => {
  it("reads the proposal's strategy bitmask lowest index first", () => {
    assert.deepEqual(activeStrategyIndices(0n), []);
    assert.deepEqual(activeStrategyIndices(1n), [0]);
    assert.deepEqual(activeStrategyIndices(0b1011n), [0, 1, 3]);
    assert.deepEqual(activeStrategyIndices(1n << 255n), [255]);
  });
});

describe("Snapshot X vote reasons", () => {
  it("pins the reason through pineapple and returns an ipfs:// URI", async () => {
    let sent: unknown;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ result: { provider: "4everland", cid: "bafkreiabc" } }));
    }) as unknown as typeof fetch;

    assert.equal(await pinReason("Supports the grant.", fakeFetch), "ipfs://bafkreiabc");
    assert.deepEqual(sent, {
      jsonrpc: "2.0",
      method: "pin",
      params: { reason: "Supports the grant." },
      protocol: "ipfs",
      id: null,
    });
  });

  it("returns null rather than failing the vote when pinning fails", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const bad = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;

    assert.equal(await pinReason("x", down), null);
    assert.equal(await pinReason("x", bad), null);
  });
});
