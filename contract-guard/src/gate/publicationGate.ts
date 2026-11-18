/**
 * Publication gate (PLAN.md §5, locked decisions L-1/L-2/L-4, D-4).
 *
 * For one candidate spec version the gate decides, in a single SQLite
 * transaction:
 * 1. Duplicate version (L-2)? A version already reserved by a `published` or
 *    `blocked` intake is rejected with `ERR_DUPLICATE_VERSION` and the locked
 *    guidance — the row is still recorded, as `rejected`.
 * 2. Invalid spec? Blocked for validity reasons, a distinct reason code from
 *    breaking changes (`ERR_INVALID_SPEC`).
 * 3. Otherwise diff against the last *published* version (D-4), attribute
 *    consumer impact, and apply the gate mode:
 *    - `consumer` (L-1 default): block when a known consumer is impacted or a
 *      past-sunset field was removed (L-4); unconsumed public breaking changes
 *      publish with recorded `WARN_UNCONSUMED_BREAKING`.
 *    - `strict`: any blocking finding blocks.
 * The verdict, every finding row (with consumer attribution), and one audit
 * event commit atomically — a mid-transaction failure rolls all of it back.
 */

import type { Database } from "../db/database.js";
import {
  DUPLICATE_VERSION_GUIDANCE,
  finding,
  type Finding,
  type FindingCode,
} from "../findings/codes.js";
import type { GateMode } from "../config.js";
import { diffWireIndexes } from "../diff/wireDiff.js";
import {
  attributeConsumerImpacts,
  type ConsumerImpact,
} from "../impact/consumerImpact.js";
import type { ConsumerUseIndex } from "../consumers/consumerIndex.js";
import type { IndexedOperation } from "../wire/operationIndex.js";

export type GateOutcome = "published" | "blocked" | "rejected";

/** Everything the pipeline knows about one candidate version. */
export interface GateCandidate {
  service: string;
  version: string;
  /** Kit-relative source path, e.g. `specs/quote-api/1-initial.yaml`. */
  sourceFile: string;
  /** Filename-prefix order within the service. */
  order: number;
  valid: boolean;
  /** Validation findings recorded at intake (e.g. ERR_INVALID_SPEC). */
  intakeFindings: Finding[];
  /** Wire index of this candidate. */
  operations: IndexedOperation[];
}

export interface GateOptions {
  mode: GateMode;
  asOfDate: Date;
  consumerIndex: ConsumerUseIndex[];
  /** All versions of the candidate's service in publication order, so the
   * last-published baseline can be picked from live DB statuses (D-4). */
  serviceVersions: GateCandidate[];
  /** Test seam: invoked inside the transaction; throwing simulates a DB
   * failure so rollback of verdict + findings + audit can be proven. */
  fault?: () => void;
}

export interface GateVerdict {
  outcome: GateOutcome;
  /** Reason codes stored with the version; ordered, deduplicated. */
  reasonCodes: FindingCode[];
  /** Findings the gate itself produced (duplicate note, unconsumed warnings). */
  gateFindings: Finding[];
  /** Consumer impacts of the diff (empty unless blocked by impact). */
  impacts: ConsumerImpact[];
  /** Which baseline rule applied. */
  baseline: "first" | "previous";
  /** Registry row id of the decided version. */
  specVersionId: number;
}

/**
 * The number to suggest when one is already reserved (L-2 guidance).
 * `1.1.0` → `1.1.1`; anything not shaped like `x.y.z` falls back to a suffix.
 */
export function nextVersionAfter(version: string): string {
  const parts = version.split(".");
  const patch = Number(parts.at(-1));
  if (parts.length >= 2 && Number.isInteger(patch)) {
    return [...parts.slice(0, -1), String(patch + 1)].join(".");
  }
  return `${version}.1`;
}

/** Statuses that reserve a version number (locked decision L-2). */
const RESERVING_STATUSES = ["published", "blocked"] as const;

interface RowIds {
  serviceId: number;
  specVersionId: number;
}

function locate(db: Database, candidate: GateCandidate): RowIds {
  const row = db
    .prepare(
      `SELECT sv.id AS specVersionId, s.id AS serviceId
       FROM spec_versions sv
       JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? AND sv.version = ? AND sv.source_file = ?`,
    )
    .get(candidate.service, candidate.version, candidate.sourceFile) as RowIds | undefined;
  if (row === undefined) {
    throw new Error(
      `intake row missing for ${candidate.service} ${candidate.version} (${candidate.sourceFile})`,
    );
  }
  return row;
}

/** The earlier reserved row that occupies this version number, if any (L-2). */
function duplicateOf(db: Database, ids: RowIds, candidate: GateCandidate) {
  return db
    .prepare(
      `SELECT sv.id AS id, sv.source_file AS sourceFile, sv.status AS status
       FROM spec_versions sv
       WHERE sv.service_id = ? AND sv.version = ? AND sv.id != ?
         AND sv.status IN (${RESERVING_STATUSES.map(() => "?").join(", ")})
       ORDER BY sv.source_file`,
    )
    .get(
      ids.serviceId,
      candidate.version,
      ids.specVersionId,
      ...RESERVING_STATUSES,
    ) as { id: number; sourceFile: string; status: string } | undefined;
}

/** Last published version of the service before the candidate (D-4). */
function lastPublishedBaseline(
  db: Database,
  ids: RowIds,
  options: GateOptions,
  candidate: GateCandidate,
): { version: GateCandidate } | undefined {
  const earlier = options.serviceVersions
    .filter((version) => version.order < candidate.order)
    .sort((left, right) => right.order - left.order);
  if (earlier.length === 0) return undefined;

  const published = db
    .prepare(
      `SELECT source_file AS sourceFile FROM spec_versions
       WHERE service_id = ? AND status = 'published'`,
    )
    .all(ids.serviceId) as Array<{ sourceFile: string }>;
  const publishedFiles = new Set(published.map((row) => row.sourceFile));

  const baseline = earlier.find((version) => publishedFiles.has(version.sourceFile));
  return baseline === undefined ? undefined : { version: baseline };
}

/** Pure verdict logic: findings + impacts + mode → outcome and reason codes. */
export function decide(input: {
  mode: GateMode;
  version: string;
  duplicate: { sourceFile: string; status: string } | undefined;
  valid: boolean;
  intakeFindings: Finding[];
  diffFindings: Finding[];
  impacts: ConsumerImpact[];
}): { outcome: GateOutcome; reasonCodes: FindingCode[]; gateFindings: Finding[] } {
  // 1. Version reservation (L-2) outranks everything: the number is taken.
  if (input.duplicate !== undefined) {
    const dup = finding(
      "ERR_DUPLICATE_VERSION",
      `version is already reserved by ${input.duplicate.sourceFile} (${input.duplicate.status}); ${DUPLICATE_VERSION_GUIDANCE} — publish this as ${nextVersionAfter(input.version)}`,
    );
    return { outcome: "rejected", reasonCodes: ["ERR_DUPLICATE_VERSION"], gateFindings: [dup] };
  }

  // 2. Validity is its own block reason, distinct from breaking changes.
  if (!input.valid) {
    const codes = dedupe(input.intakeFindings.map((item) => item.code));
    return { outcome: "blocked", reasonCodes: codes, gateFindings: [] };
  }

  // 3. Breaking-change verdict under the gate mode.
  const blocking = input.diffFindings.filter((item) => item.severity === "blocking");
  const impactedCodes = new Set(input.impacts.map((impact) => impact.code + impact.operationRef + impact.fieldPath));
  const isImpacted = (item: Finding): boolean =>
    impactedCodes.has(item.code + item.operationRef + item.fieldPath);
  // A past-sunset removal is hard-breaking regardless of consumers (L-4/PO-3).
  const isSunsetExpiry = (item: Finding): boolean => item.code === "ERR_SUNSET_REMOVAL_EXPIRED";

  const reasonSet = new Set<FindingCode>();
  const gateFindings: Finding[] = [];

  for (const item of blocking) {
    if (input.mode === "strict") {
      reasonSet.add(item.code);
    } else if (isImpacted(item) || isSunsetExpiry(item)) {
      reasonSet.add(item.code);
    } else {
      // Unconsumed public breaking change: publish with a recorded warning (L-1).
      gateFindings.push(
        finding(
          "WARN_UNCONSUMED_BREAKING",
          `unconsumed breaking change: ${item.message}`,
          { operationRef: item.operationRef, fieldPath: item.fieldPath },
        ),
      );
    }
  }

  const outcome: GateOutcome = reasonSet.size > 0 ? "blocked" : "published";
  return { outcome, reasonCodes: [...reasonSet], gateFindings };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function replaceFindings(
  db: Database,
  specVersionId: number,
  rows: Array<{ item: Finding; consumerId: number | null }>,
): void {
  db.prepare("DELETE FROM findings WHERE spec_version_id = ?").run(specVersionId);
  const insert = db.prepare(
    `INSERT INTO findings (spec_version_id, code, severity, operation_ref, field_path, consumer_id, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      specVersionId,
      row.item.code,
      row.item.severity,
      row.item.operationRef ?? null,
      row.item.fieldPath ?? null,
      row.consumerId,
      row.item.message,
    );
  }
}

/**
 * Run the gate for one candidate and persist the verdict atomically.
 * The caller (startup pipeline, Phase 7) processes candidates in filename
 * order so each sees the live statuses of the ones before it.
 */
export function runPublicationGate(
  db: Database,
  candidate: GateCandidate,
  options: GateOptions,
): GateVerdict {
  const write = db.transaction((): GateVerdict => {
    const ids = locate(db, candidate);
    const duplicate = duplicateOf(db, ids, candidate);
    const baselineEntry = lastPublishedBaseline(db, ids, options, candidate);

    // Diff and impact only make sense for a valid, non-duplicate candidate.
    const diffFindings: Finding[] =
      duplicate === undefined && candidate.valid && baselineEntry !== undefined
        ? diffWireIndexes(baselineEntry.version.operations, candidate.operations, {
            asOfDate: options.asOfDate,
          })
        : [];
    const impacts: ConsumerImpact[] =
      duplicate === undefined && candidate.valid && baselineEntry !== undefined
        ? attributeConsumerImpacts({
            service: candidate.service,
            findings: diffFindings,
            baselineOperations: baselineEntry.version.operations,
            candidateOperations: candidate.operations,
            consumerIndex: options.consumerIndex,
          })
        : [];

    const verdictPart = decide({
      mode: options.mode,
      version: candidate.version,
      duplicate,
      valid: candidate.valid,
      intakeFindings: candidate.intakeFindings,
      diffFindings,
      impacts,
    });

    // Persist: status + reason + decided_at, findings (intake + gate + impact
    // attributions), one audit event — all in this one transaction.
    db.prepare(
      `UPDATE spec_versions
       SET status = ?, outcome_reason_code = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).run(
      verdictPart.outcome,
      verdictPart.reasonCodes.join(","),
      ids.specVersionId,
    );

    const consumerIds = new Map<string, number>(
      (db.prepare("SELECT id, name FROM consumers").all() as Array<{ id: number; name: string }>).map(
        (row) => [row.name, row.id],
      ),
    );

    const findingRows: Array<{ item: Finding; consumerId: number | null }> = [
      ...candidate.intakeFindings.map((item) => ({ item, consumerId: null })),
      ...verdictPart.gateFindings.map((item) => ({ item, consumerId: null })),
      ...diffFindings.map((item) => ({ item, consumerId: null })),
      ...impacts.map((impact) => ({
        item: finding(
          impact.code,
          impact.message,
          { operationRef: impact.operationRef, fieldPath: impact.fieldPath ?? undefined },
        ),
        consumerId: consumerIds.get(impact.consumer) ?? null,
      })),
    ];
    replaceFindings(db, ids.specVersionId, findingRows);

    db.prepare(
      `INSERT INTO events (kind, service, version, outcome, detail)
       VALUES ('gate_decision', ?, ?, ?, ?)`,
    ).run(
      candidate.service,
      candidate.version,
      verdictPart.outcome,
      JSON.stringify({
        sourceFile: candidate.sourceFile,
        mode: options.mode,
        baseline: baselineEntry === undefined ? "first" : baselineEntry.version.sourceFile,
        reasonCodes: verdictPart.reasonCodes,
        impactedConsumers: dedupe(impacts.map((impact) => impact.consumer)),
        diffFindings: diffFindings.length,
      }),
    );

    options.fault?.();

    return {
      outcome: verdictPart.outcome,
      reasonCodes: verdictPart.reasonCodes,
      gateFindings: verdictPart.gateFindings,
      impacts,
      baseline: baselineEntry === undefined ? "first" : "previous",
      specVersionId: ids.specVersionId,
    };
  });

  return write();
}

/**
 * Build gate candidates from the Phase 2 index plus Phase 1 validity data.
 * Input order is preserved; callers group by service for `serviceVersions`.
 */
export function candidatesForGate(
  specs: Array<{
    service: string;
    version: string;
    sourceFile: string;
    order: number;
    operations: IndexedOperation[];
  }>,
  validity: Array<{ relativePath: string; valid: boolean; issues: Finding[] }>,
): GateCandidate[] {
  const validityByFile = new Map(validity.map((entry) => [entry.relativePath, entry]));
  return specs.map((spec) => {
    const state = validityByFile.get(spec.sourceFile);
    return {
      service: spec.service,
      version: spec.version,
      sourceFile: spec.sourceFile,
      order: spec.order,
      valid: state?.valid ?? false,
      intakeFindings: state?.issues ?? [],
      operations: spec.operations,
    };
  });
}
