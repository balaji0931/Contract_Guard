/**
 * Startup pipeline (PLAN.md §5, locked decisions L-3/L-4).
 *
 * Every launch auto-scans the kit (`specs/` + `consumers/`, read-only),
 * re-validates and re-indexes everything, then attempts publication of each
 * candidate in filename order per service through the Phase 5 gate, dispatches
 * the §8 alerts, and finally runs the sunset engine over what is published.
 *
 * L-3: this runs on EVERY startup (`fresh` is the default). Prior runs stay in
 * `events`/`alerts` as history and are never used to dedupe or skip the replay;
 * intake and indexing are idempotent, gate verdicts are recomputed from the
 * kit, and alerts re-fire.
 */

import type { Database } from "../db/database.js";
import type { Config, GateMode } from "../config.js";
import type { Logger } from "../logger.js";
import { indexKit, type KitIndexResult } from "./indexKit.js";
import {
  candidatesForGate,
  runPublicationGate,
  type GateCandidate,
  type GateVerdict,
} from "../gate/publicationGate.js";
import {
  dispatchPublicationAlerts,
  dispatchSunsetOverdueAlert,
  type AlertRecord,
  type DeliverOptions,
} from "../notify/notifier.js";
import {
  findOverdueSunsets,
  sunsetFindings,
  type PublishedServiceIndex,
  type SunsetHit,
} from "../sunset/sunsetEngine.js";

export interface StartupOptions {
  db: Database;
  config: Config;
  logger?: Logger;
  /** Delivery tuning for tests; production uses the notifier defaults. */
  deliver?: DeliverOptions;
}

export interface DecidedCandidate {
  candidate: GateCandidate;
  verdict: GateVerdict;
}

export interface StartupResult {
  index: KitIndexResult;
  /** Every candidate in the order the pipeline decided it. */
  decided: DecidedCandidate[];
  totals: { published: number; blocked: number; rejected: number };
  /** Overdue, still-consumed deprecated fields found on published versions. */
  sunsetHits: SunsetHit[];
  /** All alerts dispatched this run, in send order. */
  alerts: AlertRecord[];
}

function ownerOf(db: Database, candidate: GateCandidate): string | null {
  const row = db
    .prepare(
      `SELECT sv.owner FROM spec_versions sv JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? AND sv.source_file = ?`,
    )
    .get(candidate.service, candidate.sourceFile) as { owner: string | null } | undefined;
  return row?.owner ?? null;
}

/** Latest published version of each service, read from live DB statuses. */
export function publishedSnapshotsFrom(
  db: Database,
  candidates: GateCandidate[],
): PublishedServiceIndex[] {
  const statusOf = db.prepare(
    `SELECT sv.status AS status
     FROM spec_versions sv JOIN services s ON s.id = sv.service_id
     WHERE s.name = ? AND sv.version = ? AND sv.source_file = ?`,
  );
  const publishedByService = new Map<string, GateCandidate>();
  for (const candidate of candidates) {
    const row = statusOf.get(
      candidate.service,
      candidate.version,
      candidate.sourceFile,
    ) as { status: string } | undefined;
    if (row?.status !== "published") continue;
    const current = publishedByService.get(candidate.service);
    if (current === undefined || candidate.order > current.order) {
      publishedByService.set(candidate.service, candidate);
    }
  }

  const snapshots: PublishedServiceIndex[] = [];
  for (const [service, candidate] of [...publishedByService.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const row = db
      .prepare(
        `SELECT sv.id AS id, sv.owner AS owner FROM spec_versions sv JOIN services s ON s.id = sv.service_id
         WHERE s.name = ? AND sv.version = ? AND sv.source_file = ?`,
      )
      .get(service, candidate.version, candidate.sourceFile) as { id: number; owner: string | null };
    snapshots.push({
      service,
      specVersionId: row.id,
      version: candidate.version,
      sourceFile: candidate.sourceFile,
      owner: row.owner,
      operations: candidate.operations,
    });
  }
  return snapshots;
}

/** Persist sunset findings on the published row they were found on. */
export function persistSunsetFindings(
  db: Database,
  published: PublishedServiceIndex[],
  hits: SunsetHit[],
): void {
  const consumerIds = new Map<string, number>(
    (db.prepare("SELECT id, name FROM consumers").all() as Array<{ id: number; name: string }>).map(
      (row) => [row.name, row.id],
    ),
  );
  const write = db.transaction(() => {
    for (const snapshot of published) {
      db.prepare(
        `DELETE FROM findings
         WHERE spec_version_id = ? AND code = 'WARN_SUNSET_OVERDUE'`,
      ).run(snapshot.specVersionId);
    }
    const insert = db.prepare(
      `INSERT INTO findings (spec_version_id, code, severity, operation_ref, field_path, consumer_id, message)
       VALUES (?, 'WARN_SUNSET_OVERDUE', 'warning', ?, ?, ?, ?)`,
    );
    const byVersion = new Map(published.map((snapshot) => [snapshot.specVersionId, snapshot]));
    for (const hit of hits) {
      if (!byVersion.has(hit.specVersionId)) continue;
      for (const consumer of hit.consumers) {
        insert.run(
          hit.specVersionId,
          hit.operationRef,
          hit.fieldPath,
          consumerIds.get(consumer.consumer) ?? null,
          `field \`${hit.fieldPath}\` passed its x-sunset date ${hit.sunsetDate} (as of ${hit.asOf}) and ${consumer.consumer} still ${hit.direction} it`,
        );
      }
    }
  });
  write();
}

/**
 * Full startup run. Synchronous phases (index, gate) precede async delivery so
 * verdicts are final before any alert goes out; delivery failures never
 * change a verdict (Phase 6 contract).
 */
export async function runStartupPipeline(
  options: StartupOptions,
): Promise<StartupResult> {
  const { db, config, logger, deliver } = options;

  // 1. Auto-scan + validate + index the read-only kit (L-3: every launch).
  const index = indexKit(config.kitRoot, db, logger);

  if (!config.fresh) {
    // D-6 toggle off: keep the previously decided registry state untouched;
    // only the read-only scan/index refresh happens.
    logger?.info("pipeline replay skipped (CG_FRESH=0)", { specs: index.specs.length });
    return {
      index,
      decided: [],
      totals: { published: 0, blocked: 0, rejected: 0 },
      sunsetHits: [],
      alerts: [],
    };
  }

  // 2. Attempt publication in filename order, service by service.
  const allCandidates = candidatesForGate(index.specs, index.load.specs);
  const decided: DecidedCandidate[] = [];
  for (const service of [...index.byService.keys()].sort()) {
    const versions = allCandidates
      .filter((candidate) => candidate.service === service)
      .sort((left, right) => left.order - right.order);
    for (const candidate of versions) {
      const verdict = runPublicationGate(db, candidate, {
        mode: config.gateMode,
        asOfDate: config.asOfDate,
        consumerIndex: index.consumers,
        serviceVersions: versions,
      });
      decided.push({ candidate, verdict });
      logger?.info("gate decision", {
        service: candidate.service,
        version: candidate.version,
        file: candidate.sourceFile,
        outcome: verdict.outcome,
        reasons: verdict.reasonCodes.join(",") || "-",
        baseline: verdict.baselineVersion ?? "first",
        impacts: verdict.impacts.length,
      });
    }
  }

  // 3. §8 alerts for every verdict (fire-and-record; never throws).
  const alerts: AlertRecord[] = [];
  for (const entry of decided) {
    const records = await dispatchPublicationAlerts(
      db,
      config.webhookUrl,
      {
        service: entry.candidate.service,
        version: entry.candidate.version,
        owner: ownerOf(db, entry.candidate),
        specFile: entry.candidate.sourceFile,
        baselineVersion: entry.verdict.baselineVersion,
        verdict: entry.verdict,
        intakeFindings: entry.candidate.intakeFindings,
        asOfDate: config.asOfDate,
      },
      deliver,
    );
    alerts.push(...records);
  }

  // 4. Sunset engine over what is published (L-4).
  const published = publishedSnapshotsFrom(
    db,
    decided.map((entry) => entry.candidate),
  );
  const sunsetHits = findOverdueSunsets({
    published,
    consumerIndex: index.consumers,
    asOfDate: config.asOfDate,
  });
  persistSunsetFindings(db, published, sunsetHits);
  const byService = new Map<string, SunsetHit[]>();
  for (const hit of sunsetHits) {
    byService.set(hit.service, [...(byService.get(hit.service) ?? []), hit]);
  }
  for (const [service, hits] of [...byService.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const snapshot = published.find((item) => item.service === service);
    if (snapshot === undefined) continue;
    alerts.push(
      await dispatchSunsetOverdueAlert(
        db,
        config.webhookUrl,
        {
          service,
          owner: snapshot.owner,
          specFile: snapshot.sourceFile,
          version: snapshot.version,
          findings: sunsetFindings(hits),
          asOfDate: config.asOfDate,
        },
        deliver,
      ),
    );
  }

  const totals = {
    published: decided.filter((entry) => entry.verdict.outcome === "published").length,
    blocked: decided.filter((entry) => entry.verdict.outcome === "blocked").length,
    rejected: decided.filter((entry) => entry.verdict.outcome === "rejected").length,
  };
  logger?.info("startup pipeline complete", {
    ...totals,
    sunsetOverdue: sunsetHits.length,
    alertsSent: alerts.filter((alert) => alert.status === "sent").length,
    alertsFailed: alerts.filter((alert) => alert.status === "failed").length,
  });

  return { index, decided, totals, sunsetHits, alerts };
}

/** Re-exported for callers that only need the type. */
export type { GateMode };
