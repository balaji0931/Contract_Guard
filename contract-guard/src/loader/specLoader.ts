/**
 * Turn one discovered spec file into an intake record: parse YAML, take the
 * version from `info.version` (never the filename), validate it, and hash the
 * bytes. Nothing here throws — a bad file becomes an invalid intake.
 */
import { finding, type Finding } from "../findings/codes.js";
import type { SpecFileRef } from "./discovery.js";
import { parseYaml, readTextReadOnly, sha256 } from "./readFile.js";
import { validateSpec } from "../validator/specValidator.js";

export interface SpecIntake {
  service: string;
  order: number;
  /** Path relative to the kit root, e.g. `specs/quote-api/1-initial.yaml`. */
  relativePath: string;
  fileName: string;
  contentHash: string;
  /** `info.version`, or `""` when the spec does not declare one. */
  version: string;
  title: string | null;
  description: string | null;
  /** Owning team, parsed from the description's `Owner: … team.` sentence. */
  owner: string | null;
  valid: boolean;
  issues: Finding[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `Bike insurance quotes. Owner: Quotes team.` → `Quotes team`. */
export function parseOwner(description: string | null): string | null {
  if (description === null) return null;
  const match = /Owner:\s*([^.]*)/.exec(description);
  const owner = match?.[1]?.trim();
  return owner === undefined || owner === "" ? null : owner;
}

export function loadSpecFile(ref: SpecFileRef): SpecIntake {
  const base = {
    service: ref.service,
    order: ref.order,
    relativePath: ref.relativePath,
    fileName: ref.fileName,
  };

  const read = readTextReadOnly(ref.absolutePath);
  if (!read.ok) {
    return {
      ...base,
      contentHash: "",
      version: "",
      title: null,
      description: null,
      owner: null,
      valid: false,
      issues: [finding("ERR_INVALID_SPEC", `could not read file: ${read.error}`)],
    };
  }

  const text = read.text as string;
  const contentHash = sha256(text);

  const parsed = parseYaml(text);
  if (!parsed.ok) {
    return {
      ...base,
      contentHash,
      version: "",
      title: null,
      description: null,
      owner: null,
      valid: false,
      issues: [finding("ERR_INVALID_SPEC", `YAML parse error: ${parsed.error}`)],
    };
  }

  const document = parsed.value;
  const info =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>).info
      : undefined;
  const infoBlock =
    typeof info === "object" && info !== null && !Array.isArray(info)
      ? (info as Record<string, unknown>)
      : undefined;

  const description = asString(infoBlock?.description);
  const version = asString(infoBlock?.version) ?? "";

  // Validation runs after metadata extraction so even an invalid spec records its version.
  const issues = validateSpec(document);

  return {
    ...base,
    contentHash,
    version,
    title: asString(infoBlock?.title),
    description,
    owner: parseOwner(description),
    valid: issues.length === 0,
    issues,
  };
}
