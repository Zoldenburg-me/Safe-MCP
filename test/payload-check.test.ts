import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  getAddress,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from "viem";
import {
  checkExecutionPayload,
  checkExecutionPayloadFile,
  type ExecutionTransaction,
} from "../src/payloadCheck.js";

/**
 * Synthetic fixtures only. Selectors are the public ones the checker names.
 * None of this is a live proposal or a drain.
 */

const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const SPACE = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const OTHER = getAddress("0x4444444444444444444444444444444444444444");
const IMPL = getAddress("0x5555555555555555555555555555555555555555");
const MODULE = getAddress("0x6666666666666666666666666666666666666666");

const ERC20 = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
]);

const PROXY = parseAbi([
  "function upgradeTo(address newImplementation)",
  "function upgradeToAndCall(address newImplementation, bytes data)",
  "function upgrade(address newImplementation)",
  "function changeAdmin(address newAdmin)",
]);

const PROXY_ADMIN = parseAbi([
  "function upgrade(address proxy, address implementation)",
  "function upgradeAndCall(address proxy, address implementation, bytes data)",
]);

const SAFE = parseAbi([
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function setGuard(address guard)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function changeThreshold(uint256 _threshold)",
  "function setFallbackHandler(address handler)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
  "function multiSend(bytes transactions)",
]);

const PROXY_ADMIN_CONTROL = parseAbi([
  "function changeProxyAdmin(address proxy, address newAdmin)",
]);

const TOKEN_MORE = parseAbi([
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transfer(address to, uint256 amount, bytes data)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function send(address recipient, uint256 amount, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s)",
  "function multicall(bytes[] data)",
]);

const WORD = ("0x" + "11".repeat(32)) as Hex;

const GOVERNANCE = parseAbi(["function setFee(uint256 fee)"]);

function call(partial: Partial<ExecutionTransaction> & Pick<ExecutionTransaction, "to">): ExecutionTransaction {
  return {
    value: "0",
    data: "0x",
    operation: 0,
    targetVerified: true,
    ...partial,
  };
}

function assertOk(transactions: ExecutionTransaction[], extra: { allowlist?: string[]; treasury?: string; space?: string } = {}) {
  const verdict = checkExecutionPayload({ transactions, ...extra });
  assert.equal(verdict.verdict, "ok", verdict.reasons.join("\n"));
  assert.deepEqual(verdict.reasons, []);
}

function assertEscalate(transactions: ExecutionTransaction[], pattern: RegExp, extra: { allowlist?: string[]; treasury?: string; space?: string } = {}) {
  const verdict = checkExecutionPayload({ transactions, ...extra });
  assert.equal(verdict.verdict, "escalate");
  assert.ok(
    verdict.reasons.some((reason) => pattern.test(reason)),
    `expected ${pattern} in:\n${verdict.reasons.join("\n")}`
  );
}

/** Safe MultiSend packing, used only to build a fixture the decoder must unpack. */
function pack(tx: { operation: number; to: `0x${string}`; value: bigint; data: Hex }): Hex {
  const dataLength = BigInt((tx.data.length - 2) / 2);
  return encodePacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [tx.operation, tx.to, tx.value, dataLength, tx.data]
  );
}

describe("execution payload checker", () => {
  it("accepts an empty payload and a plain governance call", () => {
    assertOk([]);
    assertOk([
      call({
        to: TOKEN,
        data: encodeFunctionData({
          abi: GOVERNANCE,
          functionName: "setFee",
          args: [1n],
        }),
        targetVerified: false,
      }),
    ]);
  });

  it("escalates DELEGATECALL even when the target is verified and no value moves", () => {
    assertEscalate(
      [call({ to: TOKEN, operation: 1, data: "0x", targetVerified: true })],
      /DELEGATECALL \(operation 1\)/
    );
    assertEscalate(
      [call({ to: TOKEN, operation: "delegatecall", targetVerified: true })],
      /DELEGATECALL \(operation 1\)/
    );
  });

  it("escalates proxy upgrade selectors", () => {
    const cases: ExecutionTransaction[] = [
      call({
        to: TOKEN,
        data: encodeFunctionData({ abi: PROXY, functionName: "upgradeTo", args: [IMPL] }),
      }),
      call({
        to: TOKEN,
        data: encodeFunctionData({
          abi: PROXY,
          functionName: "upgradeToAndCall",
          args: [IMPL, "0x"],
        }),
      }),
      call({
        to: TOKEN,
        data: encodeFunctionData({ abi: PROXY, functionName: "upgrade", args: [IMPL] }),
      }),
      call({
        to: TOKEN,
        data: encodeFunctionData({
          abi: PROXY_ADMIN,
          functionName: "upgrade",
          args: [TOKEN, IMPL],
        }),
      }),
      call({
        to: TOKEN,
        data: encodeFunctionData({
          abi: PROXY_ADMIN,
          functionName: "upgradeAndCall",
          args: [TOKEN, IMPL, "0x"],
        }),
      }),
      call({
        to: TOKEN,
        data: encodeFunctionData({ abi: PROXY, functionName: "changeAdmin", args: [OTHER] }),
      }),
      call({
        to: TOKEN,
        data: encodeFunctionData({
          abi: parseAbi([
            "function diamondCut((address,uint8,bytes4[])[] _diamondCut, address _init, bytes _calldata)",
          ]),
          functionName: "diamondCut",
          args: [[], OTHER, "0x"],
        }),
      }),
    ];

    for (const tx of cases) {
      assertEscalate([tx], /proxy upgrade calldata/);
    }

    assert.equal(toFunctionSelector("upgradeTo(address)"), "0x3659cfe6");
    assert.equal(toFunctionSelector("upgradeToAndCall(address,bytes)"), "0x4f1ef286");
  });

  it("escalates Safe module enable, disable, and guard changes", () => {
    assertEscalate(
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({ abi: SAFE, functionName: "enableModule", args: [MODULE] }),
        }),
      ],
      /enableModule/
    );
    assertEscalate(
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "disableModule",
            args: [MODULE, OTHER],
          }),
        }),
      ],
      /disableModule/
    );
    assertEscalate(
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({ abi: SAFE, functionName: "setGuard", args: [MODULE] }),
        }),
      ],
      /setGuard/
    );
  });

  it("escalates token movement off the treasury allowlist, and allows the treasury and the space", () => {
    const pay = (to: `0x${string}`, amount: bigint) =>
      call({
        to: TOKEN,
        targetVerified: true,
        data: encodeFunctionData({
          abi: ERC20,
          functionName: "transfer",
          args: [to, amount],
        }),
      });

    assertEscalate([pay(OTHER, 1n)], /not in the|no treasury, space, or allowlist/);
    assertEscalate([pay(OTHER, 1n)], /no treasury, space, or allowlist/);

    assertOk([pay(TREASURY, 5n)], { treasury: TREASURY.toLowerCase() });
    assertOk([pay(SPACE, 5n)], { space: SPACE });
    assertOk([pay(OTHER, 5n)], { allowlist: [OTHER] });

    assertEscalate(
      [
        call({
          to: TOKEN,
          targetVerified: true,
          data: encodeFunctionData({
            abi: ERC20,
            functionName: "approve",
            args: [OTHER, 100n],
          }),
        }),
      ],
      /ERC-20 approve/,
      { treasury: TREASURY }
    );

    assertEscalate(
      [
        call({
          to: TOKEN,
          targetVerified: true,
          data: encodeFunctionData({
            abi: ERC20,
            functionName: "transferFrom",
            args: [TREASURY, OTHER, 7n],
          }),
        }),
      ],
      /ERC-20 transferFrom/,
      { treasury: TREASURY, space: SPACE }
    );
  });

  it("does not treat a zero-amount token call as movement", () => {
    assertOk([
      call({
        to: TOKEN,
        targetVerified: false,
        data: encodeFunctionData({
          abi: ERC20,
          functionName: "approve",
          args: [OTHER, 0n],
        }),
      }),
    ]);
  });

  it("escalates unverified or unknown targets only when ETH or tokens move", () => {
    assertEscalate(
      [call({ to: TOKEN, value: "1", data: "0x", targetVerified: false })],
      /has no verified source and the call moves ETH or tokens/
    );
    assertEscalate(
      [call({ to: TOKEN, value: 1n, data: "0x", targetVerified: undefined })],
      /verification was not supplied/
    );
    assertOk([call({ to: TOKEN, value: "1", data: "0x", targetVerified: true })]);

    assertEscalate(
      [
        call({
          to: TOKEN,
          targetVerified: false,
          data: encodeFunctionData({
            abi: ERC20,
            functionName: "transfer",
            args: [TREASURY, 1n],
          }),
        }),
      ],
      /has no verified source/,
      { treasury: TREASURY }
    );
  });

  it("escalates a DELEGATECALL or upgrade hidden in a MultiSend or execTransaction", () => {
    const benign = pack({ operation: 0, to: TOKEN, value: 0n, data: "0x" });
    const delegated = pack({ operation: 1, to: OTHER, value: 0n, data: "0x" });
    const upgrade = encodeFunctionData({ abi: PROXY, functionName: "upgradeTo", args: [IMPL] });
    const upgradePacked = pack({ operation: 0, to: TOKEN, value: 0n, data: upgrade });

    assertOk([
      call({
        to: SPACE,
        data: encodeFunctionData({
          abi: SAFE,
          functionName: "multiSend",
          args: [concatHex([benign, benign])],
        }),
      }),
    ]);

    assertEscalate(
      [
        call({
          to: SPACE,
          targetVerified: true,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "multiSend",
            args: [concatHex([benign, delegated])],
          }),
        }),
      ],
      /tx\[0\]\.inner\[1\]: DELEGATECALL/
    );

    assertEscalate(
      [
        call({
          to: SPACE,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "multiSend",
            args: [upgradePacked],
          }),
        }),
      ],
      /proxy upgrade calldata \(upgradeTo\(address\)\)/
    );

    const innerUpgrade = encodeFunctionData({ abi: PROXY, functionName: "upgradeTo", args: [IMPL] });
    assertEscalate(
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "execTransaction",
            args: [TOKEN, 0n, innerUpgrade, 0, 0n, 0n, 0n, OTHER, OTHER, "0x"],
          }),
        }),
      ],
      /tx\[0\]\.inner\[0\]: proxy upgrade calldata/
    );

    assertEscalate(
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "execTransaction",
            args: [TOKEN, 0n, "0x", 1, 0n, 0n, 0n, OTHER, OTHER, "0x"],
          }),
        }),
      ],
      /DELEGATECALL \(operation 1\)/
    );
  });

  it("escalates a batch that sends ETH when inner verification was not supplied", () => {
    const paid = pack({ operation: 0, to: TREASURY, value: 1n, data: "0x" });
    assertEscalate(
      [
        call({
          to: SPACE,
          targetVerified: true,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "multiSend",
            args: [paid],
          }),
        }),
      ],
      /verification was not supplied/
    );
  });

  it("escalates missing operation, bad calldata, and a malformed allowlist entry", () => {
    assertEscalate([call({ to: TOKEN, operation: undefined })], /operation is missing/);
    assertEscalate([call({ to: TOKEN, data: "0x123" })], /calldata is not valid hex/);
    assertEscalate([call({ to: "not-an-address" })], /target is not an address/);

    const verdict = checkExecutionPayload({
      transactions: [],
      allowlist: ["not-an-address"],
    });
    assert.equal(verdict.verdict, "escalate");
    assert.match(verdict.reasons[0] ?? "", /allowlist entry/);
  });

  it("reads a payload file the watch can pass to the CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payload-check-"));
    const path = join(dir, "payload.json");
    const data = encodeFunctionData({ abi: PROXY, functionName: "upgradeTo", args: [IMPL] });
    await writeFile(
      path,
      JSON.stringify({
        transactions: [{ to: TOKEN, value: "0", data, operation: 0, targetVerified: true }],
        treasury: TREASURY,
      })
    );

    const verdict = await checkExecutionPayloadFile(path);
    assert.equal(verdict.verdict, "escalate");
    assert.match(verdict.reasons.join("\n"), /upgradeTo/);
  });

  it("escalates Safe owner, threshold, fallback handler, and proxy admin changes", () => {
    const cases: Array<[ExecutionTransaction, RegExp]> = [
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "addOwnerWithThreshold",
            args: [OTHER, 1n],
          }),
        }),
        /addOwnerWithThreshold/,
      ],
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "removeOwner",
            args: [MODULE, OTHER, 1n],
          }),
        }),
        /removeOwner/,
      ],
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "swapOwner",
            args: [MODULE, OTHER, IMPL],
          }),
        }),
        /swapOwner/,
      ],
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "changeThreshold",
            args: [2n],
          }),
        }),
        /changeThreshold/,
      ],
      [
        call({
          to: TREASURY,
          data: encodeFunctionData({
            abi: SAFE,
            functionName: "setFallbackHandler",
            args: [MODULE],
          }),
        }),
        /setFallbackHandler/,
      ],
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: PROXY_ADMIN_CONTROL,
            functionName: "changeProxyAdmin",
            args: [TOKEN, OTHER],
          }),
        }),
        /changeProxyAdmin/,
      ],
    ];

    for (const [tx, pattern] of cases) {
      assertEscalate([tx], pattern);
    }
  });

  it("escalates token selectors that used to pass silently when the recipient is unexplained", () => {
    const extra = { treasury: TREASURY, space: SPACE };
    const transferWithData = encodeFunctionData({
      abi: TOKEN_MORE,
      functionName: "transfer",
      args: [OTHER, 4n, "0x"],
    });
    assert.equal(toFunctionSelector("transfer(address,uint256,bytes)"), transferWithData.slice(0, 10));

    const cases: Array<[ExecutionTransaction, RegExp]> = [
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "increaseAllowance",
            args: [OTHER, 9n],
          }),
        }),
        /ERC-20 increaseAllowance/,
      ],
      [
        call({ to: TOKEN, data: transferWithData }),
        /ERC-20 transfer\(address,uint256,bytes\)/,
      ],
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "safeTransferFrom",
            args: [TREASURY, OTHER, 0n],
          }),
        }),
        /ERC-721 safeTransferFrom/,
      ],
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "safeTransferFrom",
            args: [TREASURY, OTHER, 1n, "0xabcd"],
          }),
        }),
        /ERC-721 safeTransferFrom/,
      ],
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "safeTransferFrom",
            args: [TREASURY, OTHER, 1n, 2n, "0x"],
          }),
        }),
        /ERC-1155 safeTransferFrom/,
      ],
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "send",
            args: [OTHER, 3n, "0x"],
          }),
        }),
        /ERC-777 send/,
      ],
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "setApprovalForAll",
            args: [OTHER, true],
          }),
        }),
        /setApprovalForAll/,
      ],
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "permit",
            args: [TREASURY, OTHER, 8n, 1n, 27, WORD, WORD],
          }),
        }),
        /permit/,
      ],
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "permit",
            args: [TREASURY, OTHER, 1n, 1n, true, 27, WORD, WORD],
          }),
        }),
        /permit/,
      ],
    ];

    for (const [tx, pattern] of cases) {
      assertEscalate([tx], pattern, extra);
    }

    const hidden = encodeFunctionData({
      abi: ERC20,
      functionName: "transfer",
      args: [OTHER, 1n],
    });
    assertEscalate(
      [
        call({
          to: TOKEN,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "multicall",
            args: [[hidden]],
          }),
        }),
      ],
      /multicall\(bytes\[\]\) can hide a call/,
      extra
    );
  });

  it("does not flag a zero allowance increase, a revoked approval, or an allowlisted increase", () => {
    assertOk([
      call({
        to: TOKEN,
        targetVerified: false,
        data: encodeFunctionData({
          abi: TOKEN_MORE,
          functionName: "increaseAllowance",
          args: [OTHER, 0n],
        }),
      }),
    ]);
    assertOk([
      call({
        to: TOKEN,
        targetVerified: false,
        data: encodeFunctionData({
          abi: TOKEN_MORE,
          functionName: "setApprovalForAll",
          args: [OTHER, false],
        }),
      }),
    ]);
    assertOk(
      [
        call({
          to: TOKEN,
          targetVerified: true,
          data: encodeFunctionData({
            abi: TOKEN_MORE,
            functionName: "increaseAllowance",
            args: [TREASURY, 5n],
          }),
        }),
      ],
      { treasury: TREASURY }
    );
  });
});
