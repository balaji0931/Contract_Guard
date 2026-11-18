/**
 * Fingerprint of the read-only kit inputs. Phase 9 asserts byte identity before
 * and after a run; the digest is reproducible with
 * `find specs consumers -type f | sort | xargs shasum -a 256 | shasum -a 256`.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "./readFile.js";

export interface KitFingerprint {
  digest: string;
  fileCount: number;
  files: Array<{ relativePath: string; hash: string }>;
}

function listFiles(root: string, relativeDir: string): string[] {
  const dir = join(root, relativeDir);
  const collected: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) collected.push(...listFiles(root, relative));
    else if (entry.isFile()) collected.push(relative);
  }
  return collected;
}

export function kitFingerprint(kitRoot: string, folders: string[] = ["specs", "consumers"]): KitFingerprint {
  const relativePaths: string[] = [];
  for (const folder of folders) relativePaths.push(...listFiles(kitRoot, folder));
  relativePaths.sort((a, b) => a.localeCompare(b));

  const files = relativePaths.map((relativePath) => ({
    relativePath,
    hash: sha256(readFileSync(join(kitRoot, relativePath), "utf8")),
  }));

  const manifest = files.map((file) => `${file.hash}  ${file.relativePath}\n`).join("");
  return { digest: createHash("sha256").update(manifest, "utf8").digest("hex"), fileCount: files.length, files };
}
