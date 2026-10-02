import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  hexToBytes,
  isAddress,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

/**
 * Pure check of a proposal's execution transactions before an auto-vote.
 *
 * Snapshot hub reads in this repo do not include execution transactions, and
 * Snapshot X only stores `executionPayloadHash` on the space contract. This
 * module does not fetch either, and it does not talk to a block explorer.
 * The weekday watch passes `{to, value, data, operation}` plus `targetVerified`,
 * which it must set from a source check. Omitted verification is not "verified".
 *
 * A verdict of `escalate` is a flag for judgment, not an automatic no-vote.
 * Detection stays useful: a delegatecall or a token move is still flagged.
 * Voting is withheld only for a Safe-control change or an unexplained token
 * recipient. That decision is the watcher's, not this function's.
 */

const MAX_DEPTH = 8;
const MAX_BATCH = 64;
/** Hex length cap (~128 KiB of calldata) so a huge payload cannot stall the watch. */
const MAX_DATA_HEX = 256_000;

const UPGRADE_SELECTORS: Record<string, string> = {
  [toFunctionSelector("upgradeTo(address)")]: "upgradeTo(address)",
  [toFunctionSelector("upgradeToAndCall(address,bytes)")]: "upgradeToAndCall(address,bytes)",
  [toFunctionSelector("upgrade(address,address)")]: "upgrade(address,address)",
  [toFunctionSelector("upgradeAndCall(address,address,bytes)")]:
    "upgradeAndCall(address,address,bytes)",
  [toFunctionSelector("upgrade(address)")]: "upgrade(address)",
  [toFunctionSelector("diamondCut((address,uint8,bytes4[])[],address,bytes)")]:
    "diamondCut (EIP-2535)",
  [toFunctionSelector("changeAdmin(address)")]: "changeAdmin(address)",
};

const MODULE_SELECTORS: Record<string, string> = {
  [toFunctionSelector("enableModule(address)")]: "enableModule(address)",
  [toFunctionSelector("disableModule(address,address)")]: "disableModule(address,address)",
  [toFunctionSelector("setGuard(address)")]: "setGuard(address)",
};

/** Owner, threshold, and fallback-handler changes. Always a flag, like modules. */
const SAFE_CONTROL_SELECTORS: Record<string, string> = {
  [toFunctionSelector("addOwnerWithThreshold(address,uint256)")]:
    "addOwnerWithThreshold(address,uint256)",
  [toFunctionSelector("removeOwner(address,address,uint256)")]:
    "removeOwner(address,address,uint256)",
  [toFunctionSelector("swapOwner(address,address,address)")]: "swapOwner(address,address,address)",
  [toFunctionSelector("changeThreshold(uint256)")]: "changeThreshold(uint256)",
  [toFunctionSelector("setFallbackHandler(address)")]: "setFallbackHandler(address)",
  [toFunctionSelector("changeProxyAdmin(address,address)")]: "changeProxyAdmin(address,address)",
};

const TOKEN_SELECTORS = {
  transfer: toFunctionSelector("transfer(address,uint256)"),
  transferFrom: toFunctionSelector("transferFrom(address,address,uint256)"),
  approve: toFunctionSelector("approve(address,uint256)"),
  increaseAllowance: toFunctionSelector("increaseAllowance(address,uint256)"),
  /** ERC-223 / ERC-20 overload. Different selector from transfer(address,uint256). */
  transferWithData: toFunctionSelector("transfer(address,uint256,bytes)"),
  safeTransferFrom721: toFunctionSelector("safeTransferFrom(address,address,uint256)"),
  safeTransferFrom721Data: toFunctionSelector("safeTransferFrom(address,address,uint256,bytes)"),
  safeTransferFrom1155: toFunctionSelector(
    "safeTransferFrom(address,address,uint256,uint256,bytes)"
  ),
  send777: toFunctionSelector("send(address,uint256,bytes)"),
  setApprovalForAll: toFunctionSelector("setApprovalForAll(address,bool)"),
  permit2612: toFunctionSelector(
    "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"
  ),
  permitDai: toFunctionSelector(
    "permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)"
  ),
} as const;

/** Aggregate that can wrap a transfer. Flagged as a selector; inner calls are not decoded. */
const MULTICALL_BYTES = toFunctionSelector("multicall(bytes[])");

const MULTI_SEND = toFunctionSelector("multiSend(bytes)");
const EXEC_TRANSACTION = toFunctionSelector(
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"
);
const EXEC_FROM_MODULE = toFunctionSelector(
  "execTransactionFromModule(address,uint256,bytes,uint8)"
);
const EXEC_FROM_MODULE_RETURN = toFunctionSelector(
  "execTransactionFromModuleReturnData(address,uint256,bytes,uint8)"
);

const MULTI_SEND_ABI = parseAbi(["function multiSend(bytes transactions)"]);
const EXEC_TRANSACTION_ABI = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
]);
const EXEC_FROM_MODULE_ABI = parseAbi([
  "function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation)",
  "function execTransactionFromModuleReturnData(address to, uint256 value, bytes data, uint8 operation)",
]);

export type PayloadVerdictKind = "ok" | "escalate";

export interface ExecutionTransaction {
  to: string;
  /** Wei. Omitted means 0. Hex (0x…) or a decimal string. */
  value?: string | number | bigint;
  /** Calldata. Omitted means 0x. */
  data?: string;
  /** 0 = CALL, 1 = DELEGATECALL. Also accepts "call" / "delegatecall". */
  operation?: number | string;
  /**
   * Whether a block explorer shows verified source for `to`.
   * The checker never looks this up. Only `true` counts as verified.
   */
  targetVerified?: boolean;
}

export interface ExecutionPayloadInput {
  transactions: readonly ExecutionTransaction[];
  /**
   * Addresses allowed to receive a token transfer, approval, or permit.
   * The DAO treasury and the space contract belong here when they are known.
   */
  allowlist?: readonly string[];
  /** DAO treasury. Merged into the recipient allowlist when it is an address. */
  treasury?: string;
  /** Snapshot X space contract, or another DAO treasury address. Not an ENS id. */
  space?: string;
}

export interface PayloadVerdict {
  verdict: PayloadVerdictKind;
  reasons: string[];
}

interface FlatTx {
  label: string;
  to: string;
  value: bigint;
  data: Hex;
  operation: number | null;
  targetVerified: boolean | undefined;
}

interface Walk {
  txs: FlatTx[];
  reasons: string[];
}

const USAGE = `
payload-check — flag governance-attack shapes in a proposal execution payload.

  npm run payload-check -- payload.json

The JSON file is { transactions, allowlist?, treasury?, space? }.
Each transaction is { to, value, data, operation, targetVerified? }.
Prints { verdict: "ok" | "escalate", reasons } to stdout.
Exit 0 when the verdict is ok, 2 when it is escalate, 1 on bad input.

This process does not read the network. Set targetVerified from a source check
before calling. Escalate is a flag for judgment, not an automatic no-vote.
`.trim();

export function checkExecutionPayload(input: ExecutionPayloadInput): PayloadVerdict {
  if (!input || !Array.isArray(input.transactions)) {
    throw new Error(
      "checkExecutionPayload expects { transactions: [{ to, value, data, operation, targetVerified? }] }."
    );
  }

  const reasons: string[] = [];
  const allowlist = recipientAllowlist(input, reasons);

  input.transactions.forEach((tx, index) => {
    const walked = walk(tx, `tx[${index}]`, 0);
    reasons.push(...walked.reasons);
    for (const flat of walked.txs) {
      reasons.push(...inspect(flat, allowlist));
    }
  });

  const unique = [...new Set(reasons)];
  return unique.length === 0
    ? { verdict: "ok", reasons: [] }
    : { verdict: "escalate", reasons: unique };
}

function recipientAllowlist(input: ExecutionPayloadInput, reasons: string[]): Set<string> {
  const allow = new Set<string>();

  const add = (raw: string | undefined, origin: string) => {
    if (raw === undefined || raw === "") return;
    if (!isAddress(raw)) {
      if (origin === "allowlist") {
        reasons.push(
          `allowlist entry "${raw}" is not an address, so it does not make any recipient safe`
        );
      }
      return;
    }
    allow.add(getAddress(raw).toLowerCase());
  };

  for (const entry of input.allowlist ?? []) add(entry, "allowlist");
  add(input.treasury, "treasury");
  add(input.space, "space");
  return allow;
}

function walk(tx: ExecutionTransaction, label: string, depth: number): Walk {
  const reasons: string[] = [];

  if (tx === null || typeof tx !== "object") {
    return { txs: [], reasons: [`${label}: transaction is not an object`] };
  }

  if (depth > MAX_DEPTH) {
    return {
      txs: [],
      reasons: [`${label}: nested execution payload exceeded decode depth; not safe to auto-vote`],
    };
  }

  const operation = parseOperation(tx.operation);
  const value = parseValue(tx.value);
  const data = parseData(tx.data);

  if (operation === null) {
    reasons.push(`${label}: operation is missing or not CALL (0) / DELEGATECALL (1)`);
  } else if (operation === 1) {
    reasons.push(`${label}: DELEGATECALL (operation 1)${addressHint(tx.to)}`);
  }

  if (value === null) {
    reasons.push(`${label}: value is not a non-negative integer amount of wei`);
  }
  if (data === null) {
    reasons.push(`${label}: calldata is not valid hex`);
    return { txs: [], reasons };
  }

  const selector = data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
  const wrapper =
    selector === MULTI_SEND ||
    selector === EXEC_TRANSACTION ||
    selector === EXEC_FROM_MODULE ||
    selector === EXEC_FROM_MODULE_RETURN;

  if (wrapper) {
    const inner = unwrap(selector, data);
    if (inner === null) {
      reasons.push(`${label}: batched Safe execution payload could not be decoded`);
      return { txs: [], reasons };
    }
    if (inner.length > MAX_BATCH) {
      reasons.push(`${label}: batch has ${inner.length} calls, over the ${MAX_BATCH} auto-vote cap`);
      return { txs: [], reasons };
    }
    const txs: FlatTx[] = [];
    inner.forEach((child, index) => {
      const nested = walk(child, `${label}.inner[${index}]`, depth + 1);
      reasons.push(...nested.reasons);
      txs.push(...nested.txs);
    });
    return { txs, reasons };
  }

  if (value === null || operation === null) {
    return { txs: [], reasons };
  }

  return {
    txs: [
      {
        label,
        to: tx.to,
        value,
        data,
        operation,
        targetVerified: tx.targetVerified,
      },
    ],
    reasons,
  };
}

function unwrap(selector: string, data: Hex): ExecutionTransaction[] | null {
  try {
    if (selector === MULTI_SEND) {
      const decoded = decodeFunctionData({ abi: MULTI_SEND_ABI, data });
      const packed = decoded.args[0];
      return unpackMultiSend(packed);
    }

    const abi = selector === EXEC_TRANSACTION ? EXEC_TRANSACTION_ABI : EXEC_FROM_MODULE_ABI;
    const decoded = decodeFunctionData({ abi, data });
    const [to, value, inner, operation] = decoded.args;
    return [
      {
        to,
        value: value.toString(),
        data: inner,
        operation: Number(operation),
        // The inner target is not the outer contract. The watch must say
        // whether that target is verified; this layer does not know.
        targetVerified: undefined,
      },
    ];
  } catch {
    return null;
  }
}

/**
 * Safe MultiSend packing: uint8 operation | address to | uint256 value |
 * uint256 dataLength | bytes data, repeated. Decoding only; nothing is built
 * for submission.
 */
function unpackMultiSend(packed: Hex): ExecutionTransaction[] | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(packed);
  } catch {
    return null;
  }

  const out: ExecutionTransaction[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    if (offset + 1 + 20 + 32 + 32 > bytes.length) return null;

    const operation = bytes[offset]!;
    const to = getAddress(("0x" + bytesToHex(bytes.subarray(offset + 1, offset + 21))) as Hex);
    const value = bytesToBigInt(bytes.subarray(offset + 21, offset + 53));
    const dataLength = bytesToBigInt(bytes.subarray(offset + 53, offset + 85));
    offset += 85;

    if (dataLength > BigInt(MAX_DATA_HEX / 2)) return null;
    const length = Number(dataLength);
    if (offset + length > bytes.length) return null;

    const data = ("0x" + bytesToHex(bytes.subarray(offset, offset + length))) as Hex;
    offset += length;

    out.push({
      to,
      value: value.toString(),
      data,
      operation,
      targetVerified: undefined,
    });
  }

  return out;
}

function inspect(tx: FlatTx, allowlist: Set<string>): string[] {
  const reasons: string[] = [];
  const where = `${tx.label}`;

  if (!isAddress(tx.to)) {
    reasons.push(`${where}: target is not an address`);
  }

  const selector = tx.data.length >= 10 ? tx.data.slice(0, 10).toLowerCase() : null;
  let tokenMovement = 0n;

  if (selector && UPGRADE_SELECTORS[selector]) {
    reasons.push(
      `${where}: proxy upgrade calldata (${UPGRADE_SELECTORS[selector]})${addressHint(tx.to)}`
    );
  }

  if (selector && MODULE_SELECTORS[selector]) {
    reasons.push(
      `${where}: Safe module or guard change (${MODULE_SELECTORS[selector]})${addressHint(tx.to)}`
    );
  }

  if (selector && SAFE_CONTROL_SELECTORS[selector]) {
    reasons.push(
      `${where}: Safe control change (${SAFE_CONTROL_SELECTORS[selector]})${addressHint(tx.to)}`
    );
  }

  if (selector === MULTICALL_BYTES) {
    reasons.push(`${where}: multicall(bytes[]) can hide a call`);
  }

  if (selector && (Object.values(TOKEN_SELECTORS) as string[]).includes(selector)) {
    const token = readTokenCall(selector, tx.data);
    if (token === null) {
      reasons.push(`${where}: token calldata could not be decoded`);
    } else if (token.amount > 0n) {
      tokenMovement = token.amount;
      const recipient = token.recipient.toLowerCase();
      if (!allowlist.has(recipient)) {
        const scope =
          allowlist.size === 0
            ? "no treasury, space, or allowlist address was supplied"
            : "recipient is not the DAO treasury, the space, or an allowlisted address";
        reasons.push(
          `${where}: ${token.name} of ${token.amount} to ${getAddress(token.recipient)}; ${scope}`
        );
      }
    }
  }

  const movesValue = tx.value > 0n || tokenMovement > 0n;
  if (movesValue && tx.targetVerified !== true && isAddress(tx.to)) {
    reasons.push(
      tx.targetVerified === false
        ? `${where}: target ${getAddress(tx.to)} has no verified source and the call moves ETH or tokens`
        : `${where}: target ${getAddress(tx.to)} verification was not supplied, and the call moves ETH or tokens; the watch must set targetVerified from a source check`
    );
  }

  return reasons;
}

function readTokenCall(
  selector: string,
  data: Hex
): { name: string; recipient: Address; amount: bigint } | null {
  try {
    const body = ("0x" + data.slice(10)) as Hex;

    if (
      selector === TOKEN_SELECTORS.transfer ||
      selector === TOKEN_SELECTORS.approve ||
      selector === TOKEN_SELECTORS.increaseAllowance
    ) {
      const [recipient, amount] = decodeAbiParameters(
        parseAbiParameters("address recipient, uint256 amount"),
        body
      );
      const name =
        selector === TOKEN_SELECTORS.transfer
          ? "ERC-20 transfer"
          : selector === TOKEN_SELECTORS.approve
            ? "ERC-20 approve"
            : "ERC-20 increaseAllowance";
      return { name, recipient, amount };
    }

    if (selector === TOKEN_SELECTORS.transferWithData || selector === TOKEN_SELECTORS.send777) {
      const [recipient, amount] = decodeAbiParameters(
        parseAbiParameters("address recipient, uint256 amount, bytes data"),
        body
      );
      return {
        name:
          selector === TOKEN_SELECTORS.transferWithData
            ? "ERC-20 transfer(address,uint256,bytes)"
            : "ERC-777 send",
        recipient,
        amount,
      };
    }

    if (selector === TOKEN_SELECTORS.transferFrom) {
      const [, recipient, amount] = decodeAbiParameters(
        parseAbiParameters("address from, address recipient, uint256 amount"),
        body
      );
      return { name: "ERC-20 transferFrom", recipient, amount };
    }

    if (
      selector === TOKEN_SELECTORS.safeTransferFrom721 ||
      selector === TOKEN_SELECTORS.safeTransferFrom721Data
    ) {
      const params =
        selector === TOKEN_SELECTORS.safeTransferFrom721
          ? parseAbiParameters("address from, address recipient, uint256 tokenId")
          : parseAbiParameters("address from, address recipient, uint256 tokenId, bytes data");
      const decoded = decodeAbiParameters(params, body);
      return { name: "ERC-721 safeTransferFrom", recipient: decoded[1], amount: 1n };
    }

    if (selector === TOKEN_SELECTORS.safeTransferFrom1155) {
      const [, recipient, , amount] = decodeAbiParameters(
        parseAbiParameters(
          "address from, address recipient, uint256 id, uint256 amount, bytes data"
        ),
        body
      );
      return { name: "ERC-1155 safeTransferFrom", recipient, amount };
    }

    if (selector === TOKEN_SELECTORS.setApprovalForAll) {
      const [recipient, approved] = decodeAbiParameters(
        parseAbiParameters("address operator, bool approved"),
        body
      );
      return { name: "setApprovalForAll", recipient, amount: approved ? 1n : 0n };
    }

    if (selector === TOKEN_SELECTORS.permit2612) {
      const [, recipient, amount] = decodeAbiParameters(
        parseAbiParameters(
          "address owner, address recipient, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s"
        ),
        body
      );
      return { name: "permit", recipient, amount };
    }

    if (selector === TOKEN_SELECTORS.permitDai) {
      const [, recipient, , , allowed] = decodeAbiParameters(
        parseAbiParameters(
          "address holder, address recipient, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s"
        ),
        body
      );
      return { name: "permit", recipient, amount: allowed ? 1n : 0n };
    }

    return null;
  } catch {
    return null;
  }
}

function parseOperation(operation: ExecutionTransaction["operation"]): number | null {
  if (operation === undefined) return null;
  if (typeof operation === "number") {
    return operation === 0 || operation === 1 ? operation : null;
  }
  if (typeof operation === "string") {
    const normalized = operation.trim().toLowerCase();
    if (normalized === "0" || normalized === "call") return 0;
    if (normalized === "1" || normalized === "delegatecall") return 1;
  }
  return null;
}

function parseValue(value: ExecutionTransaction["value"]): bigint | null {
  if (value === undefined || value === null) return 0n;
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed);
    if (/^[0-9]+$/.test(trimmed)) return BigInt(trimmed);
  }
  return null;
}

function parseData(data: ExecutionTransaction["data"]): Hex | null {
  if (data === undefined || data === null || data === "") return "0x";
  if (typeof data !== "string") return null;
  const trimmed = data.trim();
  if (trimmed === "0x") return "0x";
  if (!/^0x[0-9a-fA-F]*$/.test(trimmed) || trimmed.length % 2 !== 0) return null;
  if (trimmed.length > MAX_DATA_HEX) return null;
  return trimmed.toLowerCase() as Hex;
}

function addressHint(to: string): string {
  return isAddress(to) ? ` to ${getAddress(to)}` : "";
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value;
}

/** Reads a payload file the weekday watch already wrote. No network. */
export async function checkExecutionPayloadFile(path: string): Promise<PayloadVerdict> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Payload file must be a JSON object with a transactions array.");
  }
  const body = parsed as {
    transactions?: unknown;
    allowlist?: unknown;
    treasury?: unknown;
    space?: unknown;
  };
  if (!Array.isArray(body.transactions)) {
    throw new Error("Payload file is missing a transactions array.");
  }
  return checkExecutionPayload({
    transactions: body.transactions as ExecutionTransaction[],
    ...(Array.isArray(body.allowlist) ? { allowlist: body.allowlist as string[] } : {}),
    ...(typeof body.treasury === "string" ? { treasury: body.treasury } : {}),
    ...(typeof body.space === "string" ? { space: body.space } : {}),
  });
}

async function main(argv: string[]): Promise<number> {
  const path = argv[2];
  if (!path || path === "--help" || path === "-h") {
    console.log(USAGE);
    return path ? 0 : 1;
  }

  const verdict = await checkExecutionPayloadFile(path);
  console.log(JSON.stringify(verdict, null, 2));
  return verdict.verdict === "ok" ? 0 : 2;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv)
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
