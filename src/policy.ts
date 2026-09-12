import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Config } from "./config.js";

const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);

/**
 * Files that live in the knowledge directory but are not policy: this project's
 * own documentation, and the shipped examples an operator has not replaced.
 */
function isPolicyFile(file: string): boolean {
  const lower = file.toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extname(lower))) return false;
  if (lower === "readme.md" || lower === "readme.txt") return false;
  if (/\.example\.(md|txt)$/.test(lower)) return false;
  return true;
}

export interface PolicyDoc {
  name: string;
  file: string;
}

/**
 * Voting policy documents the operator drops into KNOWLEDGE_DIR: operating
 * values, past-vote precedent, red lines. They are exposed as MCP resources so
 * the agent votes to a stated policy instead of improvising.
 */
export async function listPolicies(config: Config): Promise<PolicyDoc[]> {
  const dir = resolve(config.KNOWLEDGE_DIR);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter(isPolicyFile)
    .sort()
    .map((file) => ({ name: file.replace(/\.(md|txt)$/i, ""), file }));
}

/**
 * Reads one policy document by name. The name is resolved against the
 * knowledge directory and rejected if it escapes it, so a crafted resource URI
 * cannot read arbitrary files.
 */
export async function readPolicy(config: Config, name: string): Promise<string> {
  const dir = resolve(config.KNOWLEDGE_DIR);
  const docs = await listPolicies(config);
  const match = docs.find((doc) => doc.name === name);

  if (!match) {
    throw new Error(
      docs.length === 0
        ? `No policy documents found in ${dir}.`
        : `Unknown policy "${name}". Available: ${docs.map((d) => d.name).join(", ")}.`
    );
  }

  const path = resolve(join(dir, match.file));

  if (!path.startsWith(dir)) {
    throw new Error(`Refusing to read outside the knowledge directory: ${name}`);
  }

  return readFile(path, "utf-8");
}

/** All policy documents concatenated, for inlining into a prompt. */
export async function readAllPolicies(config: Config): Promise<string> {
  const docs = await listPolicies(config);

  if (docs.length === 0) return "";

  const sections = await Promise.all(
    docs.map(async (doc) => `## ${doc.name}\n\n${await readPolicy(config, doc.name)}`)
  );

  return sections.join("\n\n");
}
