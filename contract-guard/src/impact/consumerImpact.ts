/**
 * Consumer impact engine (PLAN.md §5). It takes the diff findings of one
 * candidate publication and attributes them to the consumers that actually
 * break, matching each `consumer_use` by (provider, method, normalized path)
 * and checking the manifest's `sends`/`reads` field paths — alias-rewritten
 * through the parameter map (D-3) — against the operation's wire fields.
 *
 * Locked rules applied here:
 * - PO-1/L-1: `x-internal` operations are skipped entirely.
 * - Rulebook: a request field added as `required` breaks consumers that do
 *   NOT send it; removed/relaxed fields break the consumers that DO send/read
 *   them.
 * - L-5: a manifest that names an enum field without listing values gets the
 *   conservative verdict when an enum option is removed — reported as a
 *   possible-usage match, with wording that says so.
 */

import type { Finding, FindingCode, FindingSeverity } from "../findings/codes.js";
import type { IndexedOperation } from "../wire/operationIndex.js";
import { resolveUse, type ConsumerUseIndex } from "../consumers/consumerIndex.js";
import { normalizePathTemplate } from "../domain/paths.js";

export interface ConsumerImpact {
  consumer: string;
  team: string | null;
  /** `consumer_uses.id` of the manifest entry that is affected. */
  useId: number;
  provider: string;
  method: string;
  /** Path template as the manifest wrote it (e.g. `/quotes/{id}`). */
  pathTemplate: string;
  /** Which side of the manifest the field lives on. */
  direction: "sends" | "reads";
  /** Same code as the underlying diff finding. */
  code: FindingCode;
  severity: FindingSeverity;
  /** Candidate-side field path, or `null` for whole-operation findings. */
  fieldPath: string | null;
  /** Manifest field path that matched, alias-rewritten to the candidate's names. */
  matchedField: string | null;
  operationRef: string;
  message: string;
  /** True for the L-5 conservative enum verdict. */
  possibleUsage: boolean;
}

export interface ImpactInput {
  /** Provider service name these findings concern, e.g. `quote-api`. */
  service: string;
  /** Findings the diff engine produced for this candidate. */
  findings: Finding[];
  /** Operations of the candidate's baseline (last published) version. */
  baselineOperations: IndexedOperation[];
  /** Operations of the candidate version. */
  candidateOperations: IndexedOperation[];
  /** The full consumer index; entries for other providers are ignored. */
  consumerIndex: ConsumerUseIndex[];
}

interface OperationRefParts {
  method: string;
  normalizedPath: string;
}

/** Parse a finding's `operationRef` back into a lookup key. */
function parseOperationRef(operationRef: string): OperationRefParts {
  const space = operationRef.indexOf(" ");
  const method = operationRef.slice(0, space).toUpperCase();
  const template = operationRef.slice(space + 1);
  return { method, normalizedPath: normalizePathTemplate(template) };
}

function operationKey(method: string, normalizedPath: string): string {
  return `${method} ${normalizedPath}`;
}

function operationAt(
  operations: IndexedOperation[],
  ref: OperationRefParts,
): IndexedOperation | undefined {
  return operations.find(
    (operation) => operationKey(operation.method, operation.normalizedPath) === operationKey(ref.method, ref.normalizedPath),
  );
}

interface FieldSides {
  request: boolean;
  response: boolean;
}

function fieldSidesOf(
  baseline: IndexedOperation | undefined,
  candidate: IndexedOperation | undefined,
  fieldPath: string,
): FieldSides {
  const sides: FieldSides = { request: false, response: false };
  for (const operation of [baseline, candidate]) {
    if (operation === undefined) continue;
    if (operation.requestFields.some((field) => field.path === fieldPath)) sides.request = true;
    if (
      operation.responseFieldsByStatus.some((group) =>
        group.fields.some((field) => field.path === fieldPath),
      )
    ) {
      sides.response = true;
    }
  }
  return sides;
}

function isBlockingCode(code: FindingCode): boolean {
  return code.startsWith("ERR_");
}

/**
 * Attribute findings to consumers. Only blocking (`ERR_`) findings can create
 * consumer impact; warnings and notes are recorded for the dashboard and the
 * gate's unconsumed-breaking logic, never as a consumer break.
 */
export function attributeConsumerImpacts(input: ImpactInput): ConsumerImpact[] {
  const { service, findings, baselineOperations, candidateOperations } = input;

  // Resolve only this provider's manifest entries against this candidate.
  const resolved = input.consumerIndex
    .filter((use) => use.provider === service)
    .map((use) => resolveUse(use, candidateOperations));

  const impacts: ConsumerImpact[] = [];

  for (const item of findings) {
    if (item.operationRef === undefined || !isBlockingCode(item.code)) continue;

    const ref = parseOperationRef(item.operationRef);
    const baselineOp = operationAt(baselineOperations, ref);
    const candidateOp = operationAt(candidateOperations, ref);

    // PO-1/L-1: internal operations skip consumer-impact checks entirely.
    if (candidateOp?.isInternal === true || baselineOp?.isInternal === true) continue;

    for (const entry of resolved) {
      const { use, resolvedSends, resolvedReads } = entry;
      if (use.method !== ref.method || use.normalizedPath !== ref.normalizedPath) continue;

      // Whole-operation removal: every consumer calling it is affected.
      if (item.code === "ERR_BREAKING_OPERATION_REMOVED") {
        impacts.push({
          ...baseOf(entry),
          direction: "reads",
          code: item.code,
          severity: item.severity,
          fieldPath: null,
          matchedField: null,
          operationRef: item.operationRef,
          message: `${use.consumer} calls ${item.operationRef}, which no longer exists`,
          possibleUsage: false,
        });
        continue;
      }

      const fieldPath = item.fieldPath as string;
      const sends = resolvedSends.includes(fieldPath);
      const reads = resolvedReads.includes(fieldPath);

      switch (item.code) {
        case "ERR_BREAKING_FIELD_NOW_REQUIRED": {
          // Breaking for consumers that DON'T send the new required field.
          if (!sends) {
            impacts.push({
              ...baseOf(entry),
              direction: "sends",
              code: item.code,
              severity: item.severity,
              fieldPath,
              matchedField: null,
              operationRef: item.operationRef,
              message: `${use.consumer} sends ${listFields(use.sends)} to ${item.operationRef} and does not send the newly required \`${fieldPath}\``,
              possibleUsage: false,
            });
          }
          break;
        }
        case "ERR_BREAKING_ENUM_VALUE_REMOVED": {
          // L-5: conservative — the manifest names the field, so removal of an
          // accepted value may break it; wording states this is not proof.
          if (sends) {
            impacts.push({
              ...baseOf(entry),
              direction: "sends",
              code: item.code,
              severity: item.severity,
              fieldPath,
              matchedField: fieldPath,
              operationRef: item.operationRef,
              message: `${use.consumer} sends \`${fieldPath}\` to ${item.operationRef}; ${item.message}. This is a possible-usage match — the manifest lists the field without enumerating values, so removal of the value may break it`,
              possibleUsage: true,
            });
          }
          break;
        }
        default: {
          // Removed / now-optional / type-changed / sunset-expired findings:
          // the consumer that reads or sends the field is the one exposed.
          const sides = fieldSidesOf(baselineOp, candidateOp, fieldPath);
          const direction: ConsumerImpact["direction"] | null =
            sides.response && reads ? "reads" : sides.request && sends ? "sends" : null;
          if (direction !== null) {
            impacts.push({
              ...baseOf(entry),
              direction,
              code: item.code,
              severity: item.severity,
              fieldPath,
              matchedField: fieldPath,
              operationRef: item.operationRef,
              message: `${use.consumer} ${direction} \`${fieldPath}\` on ${item.operationRef}: ${item.message}`,
              possibleUsage: false,
            });
          }
        }
      }
    }
  }

  return impacts.sort(
    (left, right) =>
      left.consumer.localeCompare(right.consumer) ||
      left.operationRef.localeCompare(right.operationRef) ||
      (left.fieldPath ?? "").localeCompare(right.fieldPath ?? "") ||
      left.code.localeCompare(right.code),
  );
}

function baseOf(entry: ReturnType<typeof resolveUse>): {
  consumer: string;
  team: string | null;
  useId: number;
  provider: string;
  method: string;
  pathTemplate: string;
} {
  return {
    consumer: entry.use.consumer,
    team: entry.use.team,
    useId: entry.use.useId,
    provider: entry.use.provider,
    method: entry.use.method,
    pathTemplate: entry.use.pathTemplate,
  };
}

function listFields(fields: string[]): string {
  return fields.length <= 3
    ? fields.map((field) => `\`${field}\``).join(", ")
    : `${fields.length} fields`;
}

export interface ConsumerExposure {
  consumer: string;
  team: string | null;
  issues: ConsumerImpact[];
}

/**
 * Group impacts per consumer — the "exposed consumers" view of PLAN.md §7
 * (mobile-app 2 issues, payments-svc 1, partner-portal 1, notifications-svc
 * clean). Consumers without impact are listed with zero issues.
 */
export function groupImpactsByConsumer(
  impacts: ConsumerImpact[],
  consumerIndex: ConsumerUseIndex[],
): ConsumerExposure[] {
  const byConsumer = new Map<string, ConsumerExposure>();
  for (const use of consumerIndex) {
    if (!byConsumer.has(use.consumer)) {
      byConsumer.set(use.consumer, { consumer: use.consumer, team: use.team, issues: [] });
    }
  }
  for (const impact of impacts) {
    const exposure = byConsumer.get(impact.consumer);
    if (exposure !== undefined) exposure.issues.push(impact);
  }
  return [...byConsumer.values()].sort((left, right) =>
    left.consumer.localeCompare(right.consumer),
  );
}
