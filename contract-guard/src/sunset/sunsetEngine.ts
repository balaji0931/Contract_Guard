/**
 * Sunset engine (PLAN.md §5): date-driven checks over what is actually
 * published. A deprecated field whose `x-sunset` is due (L-4: passed or, at
 * the boundary, equal to the as-of date) and that a known consumer still
 * reads or sends produces `WARN_SUNSET_OVERDUE` findings and the §8
 * `/alerts/sunset-overdue/{service}` alert. Runs at startup and on re-check.
 *
 * Advance notices for *future* sunsets are the `WARN_DEPRECATED_FIELD`
 * deprecation alerts sent at publish time (Phase 6), not this engine's job.
 */

import { finding, type Finding } from "../findings/codes.js";
import { operationRef as operationRefLabel } from "../domain/paths.js";
import { sunsetExpired } from "../domain/sunsets.js";
import { resolveUse, type ConsumerUseIndex } from "../consumers/consumerIndex.js";
import type { IndexedOperation } from "../wire/operationIndex.js";

/** The as-of instant as the ISO calendar date used for L-4 comparisons. */
export function asOfCalendarDate(asOfDate: Date): string {
  return asOfDate.toISOString().slice(0, 10);
}

/** The newest published version of one service, with its wire index. */
export interface PublishedServiceIndex {
  service: string;
  specVersionId: number;
  version: string;
  sourceFile: string;
  owner: string | null;
  operations: IndexedOperation[];
}

export interface SunsetHit {
  service: string;
  specVersionId: number;
  version: string;
  sourceFile: string;
  owner: string | null;
  operationRef: string;
  fieldPath: string;
  direction: "reads" | "sends";
  sunsetDate: string;
  /** The as-of calendar date the check ran against (ISO `YYYY-MM-DD`). */
  asOf: string;
  consumers: Array<{ consumer: string; team: string | null }>;
}

function eachField(operation: IndexedOperation): Array<{
  field: { path: string; deprecated: boolean; sunsetDate: string | null };
  side: "request" | "response";
}> {
  const fields: Array<{
    field: { path: string; deprecated: boolean; sunsetDate: string | null };
    side: "request" | "response";
  }> = [];
  for (const field of operation.requestFields) fields.push({ field, side: "request" });
  for (const group of operation.responseFieldsByStatus) {
    for (const field of group.fields) fields.push({ field, side: "response" });
  }
  return fields;
}

/**
 * Find overdue, still-consumed deprecated fields on the given published
 * indexes. Internal operations are skipped like everywhere else (PO-1).
 */
export function findOverdueSunsets(input: {
  published: PublishedServiceIndex[];
  consumerIndex: ConsumerUseIndex[];
  asOfDate: Date;
}): SunsetHit[] {
  const hits: SunsetHit[] = [];

  for (const published of input.published) {
    const uses = input.consumerIndex.filter((use) => use.provider === published.service);
    const consumersByOperation = new Map<
      string,
      Array<{ consumer: string; team: string | null; reads: string[]; sends: string[] }>
    >();
    for (const use of uses) {
      const resolved = resolveUse(use, published.operations);
      if (resolved.operation === undefined || resolved.operation.isInternal) continue;
      const key = `${resolved.operation.method} ${resolved.operation.normalizedPath}`;
      const bucket = consumersByOperation.get(key) ?? [];
      bucket.push({
        consumer: use.consumer,
        team: use.team,
        reads: resolved.resolvedReads,
        sends: resolved.resolvedSends,
      });
      consumersByOperation.set(key, bucket);
    }

    for (const operation of published.operations) {
      if (operation.isInternal) continue;
      const key = `${operation.method} ${operation.normalizedPath}`;
      const consumers = consumersByOperation.get(key) ?? [];
      if (consumers.length === 0) continue;

      for (const { field, side } of eachField(operation)) {
        if (!field.deprecated || field.sunsetDate === null) continue;
        if (!sunsetExpired(field.sunsetDate, input.asOfDate)) continue;

        const affected = consumers.filter((consumer) =>
          side === "response" ? consumer.reads.includes(field.path) : consumer.sends.includes(field.path),
        );
        if (affected.length === 0) continue;

        hits.push({
          service: published.service,
          specVersionId: published.specVersionId,
          version: published.version,
          sourceFile: published.sourceFile,
          owner: published.owner,
          operationRef: operationRefLabel(operation.method, operation.pathTemplate),
          fieldPath: field.path,
          direction: side === "response" ? "reads" : "sends",
          sunsetDate: field.sunsetDate,
          asOf: asOfCalendarDate(input.asOfDate),
          consumers: affected.map(({ consumer, team }) => ({ consumer, team })),
        });
      }
    }
  }

  return hits.sort(
    (left, right) =>
      left.service.localeCompare(right.service) ||
      left.operationRef.localeCompare(right.operationRef) ||
      left.fieldPath.localeCompare(right.fieldPath),
  );
}

/** One `WARN_SUNSET_OVERDUE` finding per hit × affected consumer (L-4). */
export function sunsetFindings(hits: SunsetHit[]): Finding[] {
  const findings: Finding[] = [];
  for (const hit of hits) {
    for (const consumer of hit.consumers) {
      findings.push(
        finding(
          "WARN_SUNSET_OVERDUE",
          `field \`${hit.fieldPath}\` passed its x-sunset date ${hit.sunsetDate} (as of ${hit.asOf}) and ${consumer.consumer} still ${hit.direction} it`,
          { operationRef: hit.operationRef, fieldPath: hit.fieldPath },
        ),
      );
    }
  }
  return findings;
}
