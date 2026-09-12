const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses a duration such as "6h", "90m", "2d 12h" or a plain millisecond
 * count. Durations appear in operator config, so the error names the input.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid duration: ${input}`);
    }
    return input;
  }

  const trimmed = input.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi)];

  if (matches.length === 0) {
    throw new Error(
      `Invalid duration "${input}". Use a form like "6h", "90m", "2d" or a number of milliseconds.`
    );
  }

  // Reject trailing junk such as "6h banana", which would otherwise parse as 6h.
  const consumed = matches.reduce((sum, m) => sum + m[0].length, 0);
  if (consumed !== trimmed.replace(/\s+/g, "").length) {
    const normalised = trimmed.replace(/\s+/g, "");
    if (consumed !== normalised.length) {
      throw new Error(`Invalid duration "${input}": unrecognised trailing text.`);
    }
  }

  return matches.reduce((total, match) => {
    const unit = UNITS[match[2]!.toLowerCase()]!;
    return total + Number(match[1]) * unit;
  }, 0);
}

/** Renders a millisecond span compactly, for logs and tool output. */
export function formatDuration(ms: number): string {
  if (ms < 0) return `-${formatDuration(-ms)}`;
  if (ms < 1_000) return `${ms}ms`;

  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);

  const parts = [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    !days && !hours && seconds ? `${seconds}s` : "",
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "0s";
}
