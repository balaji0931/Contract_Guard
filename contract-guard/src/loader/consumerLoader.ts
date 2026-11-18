/**
 * Turn one consumer manifest into an intake record. Manifests describe what a
 * service sent and read when the file was written, mixing body fields and
 * parameters in `sends` and using `[]` for list items (PLAN.md §2).
 */
import { finding, type Finding } from "../findings/codes.js";
import { normalizePathTemplate } from "../domain/paths.js";
import type { ConsumerFileRef } from "./discovery.js";
import { parseYaml, readTextReadOnly, sha256 } from "./readFile.js";

export interface ConsumerUseIntake {
  provider: string;
  method: string;
  pathTemplate: string;
  normalizedPath: string;
  sends: string[];
  reads: string[];
}

export interface ConsumerIntake {
  /** Name from the manifest's `consumer:` field, falling back to the file stem. */
  name: string;
  team: string | null;
  relativePath: string;
  fileName: string;
  contentHash: string;
  uses: ConsumerUseIntake[];
  valid: boolean;
  issues: Finding[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export function loadConsumerFile(ref: ConsumerFileRef): ConsumerIntake {
  const base = {
    name: ref.name,
    team: null as string | null,
    relativePath: ref.relativePath,
    fileName: ref.fileName,
    contentHash: "",
    uses: [] as ConsumerUseIntake[],
  };

  const read = readTextReadOnly(ref.absolutePath);
  if (!read.ok) {
    return {
      ...base,
      valid: false,
      issues: [finding("ERR_INVALID_SPEC", `could not read file: ${read.error}`)],
    };
  }

  const text = read.text as string;
  const contentHash = sha256(text);

  const parsed = parseYaml(text);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return {
      ...base,
      contentHash,
      valid: false,
      issues: [
        finding(
          "ERR_INVALID_SPEC",
          `consumer manifest is not a valid YAML mapping: ${parsed.error ?? "not a mapping"}`,
        ),
      ],
    };
  }

  const document = parsed.value;
  const issues: Finding[] = [];

  const name = typeof document.consumer === "string" && document.consumer.trim() !== ""
    ? document.consumer.trim()
    : ref.name;
  if (typeof document.consumer !== "string" || document.consumer.trim() === "") {
    issues.push(finding("ERR_INVALID_SPEC", "manifest has no `consumer:` name, using the file stem"));
  }

  const team = typeof document.team === "string" && document.team.trim() !== ""
    ? document.team.trim()
    : null;

  const rawUses = document.uses;
  const uses: ConsumerUseIntake[] = [];
  if (!Array.isArray(rawUses)) {
    issues.push(finding("ERR_INVALID_SPEC", "manifest has no `uses:` list"));
  } else {
    rawUses.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        issues.push(finding("ERR_INVALID_SPEC", `uses[${index}] is not a mapping`));
        return;
      }
      const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
      const method = typeof entry.method === "string" ? entry.method.trim().toUpperCase() : "";
      const pathTemplate = typeof entry.path === "string" ? entry.path.trim() : "";
      if (provider === "" || method === "" || pathTemplate === "") {
        issues.push(
          finding("ERR_INVALID_SPEC", `uses[${index}] is missing provider, method or path`),
        );
        return;
      }
      uses.push({
        provider,
        method,
        pathTemplate,
        normalizedPath: normalizePathTemplate(pathTemplate),
        sends: stringList(entry.sends),
        reads: stringList(entry.reads),
      });
    });
  }

  return {
    name,
    team,
    relativePath: ref.relativePath,
    fileName: ref.fileName,
    contentHash,
    uses,
    valid: issues.length === 0,
    issues,
  };
}
