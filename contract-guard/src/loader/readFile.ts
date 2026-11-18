/**
 * Read-only file access plus YAML parsing (kit rule: `specs/` and `consumers/`
 * are never written). Files are opened through an explicit read-only descriptor
 * so an accidental write is impossible at the syscall level.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { load } from "js-yaml";

export interface ReadResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/** Read a file strictly read-only; never throws. */
export function readTextReadOnly(absolutePath: string): ReadResult {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, "r");
    return { ok: true, text: readFileSync(descriptor, "utf8") };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface YamlResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Parse YAML without throwing; `js-yaml` also reports duplicate mapping keys. */
export function parseYaml(text: string): YamlResult {
  try {
    return { ok: true, value: load(text) };
  } catch (error) {
    return { ok: false, error: (error as Error).message.split("\n")[0] ?? "unknown YAML error" };
  }
}
