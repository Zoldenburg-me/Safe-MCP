# Execution payload watch

Before Voterbot auto-votes a Snapshot or Snapshot X proposal, inspect the proposal's execution transactions. The result is a flag, not a ban, and it does not choose For or Against.

Snapshot proposals in this repo are read from the hub without execution transactions. Snapshot X proposals are read from the space contract, which stores `executionPayloadHash` and not the calls themselves. `checkExecutionPayload` (`src/payloadCheck.ts`) does not fetch either and does not contact a block explorer. The weekday watch passes the transactions it already resolved, each as `{ to, value, data, operation, targetVerified }`.

`targetVerified` is an input. Set it from a source-code check on `to` (verified source, or not). Only `true` means verified. If the flag is omitted, any call that moves ETH or tokens is escalated, because the checker cannot see an explorer. Unpack a Safe `multiSend` or `execTransaction` batch down to the inner calls first if you know each inner target's verification; the checker also unpacks those wrappers so a nested DELEGATECALL is not missed, and it treats those inner targets as unverified unless you pass them already split with their own flags. `multicall(bytes[])` is not unpacked. Its selector is flagged because the bytes can hide a call.

`treasury`, `space` (the space contract address, not an ENS id), and `allowlist` are the only recipients that may receive a non-zero token move or approval without a flag. That covers ERC-20 `transfer`, `transfer(address,uint256,bytes)`, `transferFrom`, `approve`, and `increaseAllowance`; ERC-721 `safeTransferFrom` (both overloads); ERC-1155 `safeTransferFrom`; ERC-777 `send`; `setApprovalForAll` when approval is granted; and `permit` (ERC-2612 and DAI-style). If none of those addresses are known, every such call with a non-zero amount is escalated. A zero amount, or `setApprovalForAll` / DAI `permit` that revokes, is not treated as movement. An ERC-721 `safeTransferFrom` always counts as a move, including token id 0.

## Flag these for a judgment call

- `operation` is DELEGATECALL (`1`), including inside a Safe `multiSend` or `execTransaction`.
- Calldata is a proxy upgrade: `upgradeTo`, `upgradeToAndCall`, `upgrade(address)`, `upgrade(address,address)`, `upgradeAndCall(address,address,bytes)`, EIP-2535 `diamondCut`, or `changeAdmin`.
- Calldata changes Safe control: `enableModule`, `disableModule`, `setGuard`, `addOwnerWithThreshold`, `removeOwner`, `swapOwner`, `changeThreshold`, `setFallbackHandler`, or `changeProxyAdmin(address,address)`.
- Calldata is `multicall(bytes[])`. The checker does not decode the inner bytes.
- A token move or approval listed above, with a non-zero amount, pays or approves an address that is not the DAO treasury, the space contract, or an explicit allowlist entry.
- The target has no verified source (`targetVerified` is `false` or was not supplied) and the call sends ETH or a non-zero token amount.

A zero-value call with no token movement, and with none of the selectors above, is `ok` even when the target is unverified. No transactions means there is no execution payload, which is `ok`. A delegatecall stays a flag. A recognized token move to an unexplained recipient stays a flag. Neither is rewritten to `ok`.

An escalate verdict is a flag. It is not an automatic no-vote. Vote when the call is a normal protocol action inside the proposal's stated purpose, including a delegatecall or a token move you can explain. Do not vote, and send the proposal to Aurel von Zoldenburg, only when the call changes Safe control (module, guard, owner, threshold, fallback handler, or an upgrade of our own proxy) or sends tokens to an address that cannot be explained.

## How to run it

From the repo:

```
npm run payload-check -- payload.json
```

`payload.json` is `{ "transactions": [ { "to", "value", "data", "operation", "targetVerified" } ], "allowlist": [], "treasury": "0x…", "space": "0x…" }`. Stdout is `{ "verdict": "ok" | "escalate", "reasons": [] }`. Exit status is `0` for ok, `2` for escalate, and `1` for bad input. The weekday watch should read the JSON, not only the exit status.

Code can call `checkExecutionPayload` from `src/payloadCheck.ts` with the same object. The function is pure and does not read `.env` or the network.
