/**
 * Phase 2 pipeline: take the Phase 1 intake and build the wire index for every
 * spec version (operations + flattened fields, persisted to `operations` and
 * `wire_fields`) and the consumer index (manifests with normalized paths and
 * alias-resolved field lookups). The startup sequence in Phase 7 calls this.
 */
import type { Database } from "../db/database.js";
import type { Logger } from "../logger.js";
import { loadKit, type KitLoadResult } from "./loadKit.js";
import { indexOperations, type IndexedOperation } from "../wire/operationIndex.js";
import { recordWireIndex } from "../registry/wireStore.js";
import { loadConsumerIndex, type ConsumerUseIndex } from "../consumers/consumerIndex.js";

export interface IndexedSpec {
  specVersionId: number;
  service: string;
  version: string;
  /** Kit-relative path, e.g. `specs/quote-api/2-reorganised.yaml`. */
  sourceFile: string;
  fileName: string;
  order: number;
  operations: IndexedOperation[];
}

export interface KitIndexResult {
  load: KitLoadResult;
  specs: IndexedSpec[];
  byService: Map<string, IndexedSpec[]>;
  consumers: ConsumerUseIndex[];
  totals: { operations: number; fields: number };
}

function specVersionId(
  db: Database,
  service: string,
  version: string,
  sourceFile: string,
): number {
  const row = db
    .prepare(
      `SELECT sv.id AS id
       FROM spec_versions sv
       JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? AND sv.version = ? AND sv.source_file = ?`,
    )
    .get(service, version, sourceFile) as { id: number } | undefined;
  if (row === undefined) {
    throw new Error(`intake row missing for ${service} ${version} (${sourceFile})`);
  }
  return row.id;
}

export function indexKit(kitRoot: string, db: Database, logger?: Logger): KitIndexResult {
  const load = loadKit(kitRoot, db, logger);
  const log = logger;

  const specs: IndexedSpec[] = [];
  const byService = new Map<string, IndexedSpec[]>();
  const totals = { operations: 0, fields: 0 };

  for (const intake of load.specs) {
    const id = specVersionId(db, intake.service, intake.version, intake.relativePath);
    const operations = indexOperations(intake.document);
    const summary = recordWireIndex(db, id, operations);
    totals.operations += summary.operations;
    totals.fields += summary.fields;

    const indexed: IndexedSpec = {
      specVersionId: id,
      service: intake.service,
      version: intake.version,
      sourceFile: intake.relativePath,
      fileName: intake.fileName,
      order: intake.order,
      operations,
    };
    specs.push(indexed);
    const bucket = byService.get(intake.service) ?? [];
    bucket.push(indexed);
    byService.set(intake.service, bucket);
  }

  const consumers = loadConsumerIndex(db);
  log?.info("wire and consumer indexes built", {
    specVersions: specs.length,
    operations: totals.operations,
    fields: totals.fields,
    consumerUses: consumers.length,
  });

  return { load, specs, byService, consumers, totals };
}

/** Look up one indexed version by service and file-name prefix, e.g. `2-`. */
export function findIndexedSpec(
  index: KitIndexResult,
  service: string,
  fileNamePrefix: string,
): IndexedSpec | undefined {
  return (index.byService.get(service) ?? []).find((spec) => spec.fileName.startsWith(fileNamePrefix));
}
