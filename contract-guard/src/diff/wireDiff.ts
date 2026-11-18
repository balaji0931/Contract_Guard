/**
 * The diff engine (PLAN.md §6 rulebook, L-6 code vocabulary). It compares the
 * wire index of a candidate version against its baseline — always the last
 * *published* version, never a blocked one (locked decision D-4) — and emits
 * findings for every rulebook verdict. This module knows nothing about which
 * baseline to choose or which consumers are affected; the gate (Phase 5) and
 * the impact engine (Phase 4) compose around it.
 *
 * Rulebook mapping:
 * - response field removed                     → ERR_BREAKING_FIELD_REMOVED
 * - deprecated response/request field removed  → ERR_SUNSET_REMOVAL_EXPIRED when
 *   its `x-sunset` is due (L-4), else ERR_BREAKING_FIELD_REMOVED
 * - response field removed from `required`     → ERR_BREAKING_FIELD_NOW_OPTIONAL
 * - response field added (even required)       → additive, no finding
 * - request field added as required            → ERR_BREAKING_FIELD_NOW_REQUIRED
 * - request field removed                      → ERR_BREAKING_FIELD_REMOVED
 * - request field made optional                → safe, no finding
 * - enum value removed from a sent field       → ERR_BREAKING_ENUM_VALUE_REMOVED
 * - enum value added to a returned field       → WARN_ENUM_VALUE_ADDED
 * - type/format change                         → ERR_BREAKING_TYPE_CHANGED
 * - operation removed                          → ERR_BREAKING_OPERATION_REMOVED
 * - field newly `deprecated: true`             → WARN_DEPRECATED_FIELD
 * - anything on an `x-internal` operation      → WARN_INTERNAL_CHANGE_NOTED (PO-1)
 */

import {
  finding,
  type Finding,
  type FindingOptions,
} from "../findings/codes.js";
import { operationRef } from "../domain/paths.js";
import { sunsetExpired } from "../domain/sunsets.js";
import { applyParamAlias, buildParamAliasMap } from "../wire/aliases.js";
import type { IndexedOperation } from "../wire/operationIndex.js";
import type { WireField } from "../wire/schemaWalker.js";

export interface DiffOptions {
  /** Pinned "today" for sunset comparisons (locked decision L-4). */
  asOfDate: Date;
}

/** One recorded parameter rename (rulebook: refactor + alias recorded). */
export interface ParamAliasRecord {
  operationRef: string;
  baselinePath: string;
  candidatePath: string;
  aliasMap: Record<string, string>;
}

function fieldKey(direction: "request" | "response", statusCode: string | null, path: string): string {
  return `${direction}\u0000${statusCode ?? "-"}\u0000${path}`;
}

function operationKey(operation: Pick<IndexedOperation, "method" | "normalizedPath">): string {
  return `${operation.method} ${operation.normalizedPath}`;
}

/**
 * Flatten an operation's fields into the comparable key map the diff walks.
 * Baseline request fields that ARE path parameters get rewritten through the
 * alias map, so `/quotes/{id}` → `/quotes/{quoteId}` cancels out instead of
 * reading as a removal plus an addition (locked decision D-3).
 */
function fieldMapOf(
  operation: IndexedOperation,
  aliasMap: Record<string, string> = {},
): Map<string, WireField> {
  const parameterNames = new Set(operation.parameters.map((parameter) => parameter.name));
  const map = new Map<string, WireField>();
  for (const field of operation.requestFields) {
    const path = parameterNames.has(field.path) ? applyParamAlias(field.path, aliasMap) : field.path;
    map.set(fieldKey("request", null, path), field);
  }
  for (const group of operation.responseFieldsByStatus) {
    for (const field of group.fields) {
      map.set(fieldKey("response", group.statusCode, field.path), field);
    }
  }
  return map;
}

function enumValues(field: WireField): string[] {
  return field.enumValues ?? [];
}

/**
 * Compare one field present in both versions. `direction` is the field's
 * direction; rulebook verdicts differ per direction.
 */
function compareFields(
  ref: string,
  direction: "request" | "response",
  before: WireField,
  after: WireField,
): Finding[] {
  const findings: Finding[] = [];
  const options: FindingOptions = { operationRef: ref, fieldPath: after.path };

  // Type/format change — breaking in both directions.
  const typeChanged =
    (before.type !== null && after.type !== null && before.type !== after.type) ||
    (before.format !== null && after.format !== null && before.format !== after.format);
  if (typeChanged) {
    findings.push(
      finding(
        "ERR_BREAKING_TYPE_CHANGED",
        `${direction === "request" ? "request" : "response"} field \`${after.path}\` changed type from ${before.type ?? "?"}${before.format ? ` (${before.format})` : ""} to ${after.type ?? "?"}${after.format ? ` (${after.format})` : ""}`,
        options,
      ),
    );
  }

  if (direction === "request") {
    // Sending a field the consumer may not know about is breaking; relaxing a
    // requirement is explicitly safe.
    if (!before.required && after.required) {
      findings.push(
        finding(
          "ERR_BREAKING_FIELD_NOW_REQUIRED",
          `request field \`${after.path}\` is now required`,
          options,
        ),
      );
    }
    // Enum shrink: the server stops accepting a value consumers may send (L-5).
    const dropped = enumValues(before).filter((value) => !enumValues(after).includes(value));
    if (dropped.length > 0) {
      findings.push(
        finding(
          "ERR_BREAKING_ENUM_VALUE_REMOVED",
          `request field \`${after.path}\` no longer accepts enum value(s): ${dropped.join(", ")}`,
          options,
        ),
      );
    }
  } else {
    // A promised response field that may now be absent is breaking; a field
    // becoming newly required is a stronger promise and safe.
    if (before.required && !after.required) {
      findings.push(
        finding(
          "ERR_BREAKING_FIELD_NOW_OPTIONAL",
          `response field \`${after.path}\` is no longer guaranteed (removed from \`required\`)`,
          options,
        ),
      );
    }
    // Enum growth: readers that switch exhaustively over values may crash.
    const added = enumValues(after).filter((value) => !enumValues(before).includes(value));
    if (added.length > 0) {
      findings.push(
        finding(
          "WARN_ENUM_VALUE_ADDED",
          `response field \`${after.path}\` gained enum value(s): ${added.join(", ")}`,
          options,
        ),
      );
    }
  }

  // A field newly marked deprecated carries an advance sunset notice.
  if (!before.deprecated && after.deprecated) {
    findings.push(
      finding(
        "WARN_DEPRECATED_FIELD",
        `field \`${after.path}\` is now deprecated${after.sunsetDate ? ` (removal scheduled for ${after.sunsetDate})` : ""}`,
        options,
      ),
    );
  }

  return findings;
}

/** Findings for a field present in the baseline but gone from the candidate. */
function removedFieldFindings(
  ref: string,
  direction: "request" | "response",
  before: WireField,
  options: DiffOptions,
): Finding[] {
  const opts: FindingOptions = { operationRef: ref, fieldPath: before.path };
  if (before.deprecated && before.sunsetDate !== null && sunsetExpired(before.sunsetDate, options.asOfDate)) {
    return [
      finding(
        "ERR_SUNSET_REMOVAL_EXPIRED",
        `deprecated field \`${before.path}\` was removed after its x-sunset date ${before.sunsetDate} passed`,
        opts,
      ),
    ];
  }
  const sunsetNote =
    before.deprecated && before.sunsetDate !== null
      ? ` (deprecated, removal scheduled for ${before.sunsetDate})`
      : "";
  return [
    finding(
      "ERR_BREAKING_FIELD_REMOVED",
      `${direction === "request" ? "request" : "response"} field \`${before.path}\` was removed${sunsetNote}`,
      opts,
    ),
  ];
}

/** Findings for a field the candidate has that the baseline lacked. */
function addedFieldFindings(
  ref: string,
  direction: "request" | "response",
  after: WireField,
): Finding[] {
  // Response additions are additive; a required request field forces consumers
  // to start sending it.
  if (direction === "request" && after.required) {
    return [
      finding(
        "ERR_BREAKING_FIELD_NOW_REQUIRED",
        `request field \`${after.path}\` is new and required`,
        { operationRef: ref, fieldPath: after.path },
      ),
    ];
  }
  return [];
}

/**
 * Downgrade every blocking finding of an `x-internal` operation to an
 * informational note: internal operations skip consumer-impact checks and the
 * gate entirely (locked decision PO-1/L-1). Warnings stay warnings.
 */
function applyInternalPolicy(findings: Finding[], ref: string): Finding[] {
  return findings.flatMap((item) => {
    if (item.severity !== "blocking") return [item];
    return [
      finding(
        "WARN_INTERNAL_CHANGE_NOTED",
        `change on internal operation ${ref}: ${item.message}`,
        { operationRef: ref, fieldPath: item.fieldPath },
      ),
    ];
  });
}

function diffOperation(
  before: IndexedOperation,
  after: IndexedOperation,
  options: DiffOptions,
): Finding[] {
  const ref = operationRef(after.method, after.pathTemplate);
  const findings: Finding[] = [];

  const aliasMap = buildParamAliasMap(before.pathTemplate, after.pathTemplate);
  const beforeFields = fieldMapOf(before, aliasMap);
  const afterFields = fieldMapOf(after);

  for (const [key, beforeField] of beforeFields) {
    const direction = key.startsWith("request") ? "request" : "response";
    const afterField = afterFields.get(key);
    if (afterField === undefined) {
      findings.push(...removedFieldFindings(ref, direction, beforeField, options));
    } else {
      findings.push(...compareFields(ref, direction, beforeField, afterField));
    }
  }

  for (const [key, afterField] of afterFields) {
    if (beforeFields.has(key)) continue;
    const direction = key.startsWith("request") ? "request" : "response";
    findings.push(...addedFieldFindings(ref, direction, afterField));
  }

  if (before.isInternal || after.isInternal) return applyInternalPolicy(findings, ref);
  return findings;
}

/**
 * Parameter renames between a baseline and a candidate, recorded so consumer
 * resolution can map old names to new (rulebook row 11, locked decision D-3).
 */
export function collectParamAliases(
  baseline: IndexedOperation[],
  candidate: IndexedOperation[],
): ParamAliasRecord[] {
  const candidateByKey = new Map(candidate.map((operation) => [operationKey(operation), operation]));
  const records: ParamAliasRecord[] = [];
  for (const before of baseline) {
    const after = candidateByKey.get(operationKey(before));
    if (after === undefined) continue;
    const aliasMap = buildParamAliasMap(before.pathTemplate, after.pathTemplate);
    if (Object.keys(aliasMap).length === 0) continue;
    records.push({
      operationRef: operationRef(after.method, after.pathTemplate),
      baselinePath: before.pathTemplate,
      candidatePath: after.pathTemplate,
      aliasMap,
    });
  }
  return records;
}

/**
 * Diff a candidate's indexed operations against its baseline's. Operations are
 * paired on method + normalized path, so a parameter rename alone yields zero
 * findings (locked decision D-3).
 */
export function diffWireIndexes(
  baseline: IndexedOperation[],
  candidate: IndexedOperation[],
  options: DiffOptions,
): Finding[] {
  const baselineByKey = new Map(baseline.map((operation) => [operationKey(operation), operation]));
  const candidateByKey = new Map(candidate.map((operation) => [operationKey(operation), operation]));
  const findings: Finding[] = [];

  for (const [key, before] of baselineByKey) {
    const after = candidateByKey.get(key);
    if (after === undefined) {
      // The operation is gone: consumers calling it are cut off (rulebook).
      if (before.isInternal) {
        findings.push(
          finding("WARN_INTERNAL_CHANGE_NOTED", `internal operation ${key} removed`, {
            operationRef: key,
          }),
        );
      } else {
        findings.push(
          finding("ERR_BREAKING_OPERATION_REMOVED", `operation ${key} was removed`, {
            operationRef: key,
          }),
        );
      }
      continue;
    }
    findings.push(...diffOperation(before, after, options));
  }

  // Operations only in the candidate are additions — never breaking.

  // Deterministic order: operation, then code, then field path.
  const codeOrder: Record<string, number> = {};
  return findings.sort((left, right) =>
    (left.operationRef ?? "").localeCompare(right.operationRef ?? "") ||
    left.code.localeCompare(right.code) ||
    (left.fieldPath ?? "").localeCompare(right.fieldPath ?? ""),
  );
}
