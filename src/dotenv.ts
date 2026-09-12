import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, resolved from this file's location inside dist/. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Parses a .env file. Deliberately minimal: KEY=VALUE lines, # comments, and
 * optional surrounding quotes. Anything fancier belongs in a real deployment
 * tool, not in a file the operator edits by hand.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    if (key) values[key] = value;
  }

  return values;
}

/**
 * Loads .env from the working directory, then from the package root, without
 * overriding anything already in the environment. An MCP client may launch the
 * server from an unrelated directory, so the package root is checked too.
 */
export function loadDotEnv(explicitPath?: string): string | null {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [resolve(process.cwd(), ".env"), join(packageRoot(), ".env")];

  for (const path of candidates) {
    let contents: string;

    try {
      contents = readFileSync(path, "utf-8");
    } catch {
      continue;
    }

    for (const [key, value] of Object.entries(parseDotEnv(contents))) {
      // A real environment variable always wins over the file.
      if (process.env[key] === undefined) process.env[key] = value;
    }

    return path;
  }

  return null;
}
