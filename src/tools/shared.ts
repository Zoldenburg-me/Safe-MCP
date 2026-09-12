import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A successful tool result carrying human-readable text. */
export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

/** A successful tool result carrying structured JSON plus a text rendering. */
export function json(value: unknown, summary?: string): CallToolResult {
  const body = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text: summary ? `${summary}\n\n${body}` : body }],
    structuredContent: value as Record<string, unknown>,
  };
}

/** An error result. MCP reports tool failures in-band so the agent can react. */
export function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wraps a tool handler so any thrown error becomes an in-band error result
 * instead of tearing down the JSON-RPC connection.
 */
export function guard<Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult>
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return failure(error);
    }
  };
}

/** Formats a unix-seconds timestamp as an ISO string, or "-" when absent. */
export function isoTime(seconds: number | string | null | undefined): string {
  if (seconds === null || seconds === undefined) return "-";
  const value = Number(seconds);
  if (!Number.isFinite(value) || value === 0) return "-";
  return new Date(value * 1000).toISOString();
}

/** Relative time such as "in 3d 4h" or "2h ago". */
export function relativeTime(seconds: number | string | null | undefined): string {
  if (seconds === null || seconds === undefined) return "-";
  const target = Number(seconds) * 1000;
  if (!Number.isFinite(target) || target === 0) return "-";

  const delta = target - Date.now();
  const abs = Math.abs(delta);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);

  const parts = [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    days === 0 && minutes > 0 ? `${minutes}m` : "",
  ].filter(Boolean);

  const span = parts.length > 0 ? parts.join(" ") : "under a minute";

  return delta >= 0 ? `in ${span}` : `${span} ago`;
}
