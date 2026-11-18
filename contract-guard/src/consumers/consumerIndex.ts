/**
 * Consumer index: the stored `consumer_uses` rows plus the machinery that
 * resolves a manifest against a service's wire index. Matching is by method and
 * normalized path, and the manifest's field paths are rewritten through the
 * positional parameter-alias map, so a manifest written against `/quotes/{id}`
 * still resolves against a spec that renamed it to `/quotes/{quoteId}` (D-3).
 */
import type { Database } from "../db/database.js";
import type { IndexedOperation } from "../wire/operationIndex.js";
import { applyParamAlias, buildParamAliasMap } from "../wire/aliases.js";

export interface ConsumerUseIndex {
  useId: number;
  consumer: string;
  team: string | null;
  provider: string;
  method: string;
  pathTemplate: string;
  normalizedPath: string;
  sends: string[];
  reads: string[];
}

export interface ResolvedUse {
  use: ConsumerUseIndex;
  /** The operation the manifest addresses, or `undefined` when the provider has none. */
  operation: IndexedOperation | undefined;
  /** Parameter renames between the manifest template and the operation template. */
  aliasMap: Record<string, string>;
  /** Manifest `sends` after alias rewriting, in the operation's own names. */
  resolvedSends: string[];
  /** Manifest `reads` after alias rewriting. */
  resolvedReads: string[];
}

export function loadConsumerIndex(db: Database): ConsumerUseIndex[] {
  const uses = db
    .prepare(
      `SELECT cu.id AS use_id, c.name AS consumer, c.team AS team,
              cu.provider AS provider, cu.method AS method,
              cu.path_template AS path_template, cu.normalized_path AS normalized_path
       FROM consumer_uses cu
       JOIN consumers c ON c.id = cu.consumer_id
       ORDER BY c.name, cu.provider, cu.method, cu.path_template`,
    )
    .all() as Array<{
    use_id: number;
    consumer: string;
    team: string | null;
    provider: string;
    method: string;
    path_template: string;
    normalized_path: string;
  }>;

  const fields = db.prepare(
    "SELECT use_id, direction, field_path FROM consumer_use_fields ORDER BY id",
  ).all() as Array<{ use_id: number; direction: "sends" | "reads"; field_path: string }>;

  const byUse = new Map<number, { sends: string[]; reads: string[] }>();
  for (const row of fields) {
    const bucket = byUse.get(row.use_id) ?? { sends: [], reads: [] };
    bucket[row.direction].push(row.field_path);
    byUse.set(row.use_id, bucket);
  }

  return uses.map((row) => ({
    useId: row.use_id,
    consumer: row.consumer,
    team: row.team,
    provider: row.provider,
    method: row.method,
    pathTemplate: row.path_template,
    normalizedPath: row.normalized_path,
    sends: byUse.get(row.use_id)?.sends ?? [],
    reads: byUse.get(row.use_id)?.reads ?? [],
  }));
}

/** Same wire path and method — parameter names are irrelevant (D-3). */
export function matchesOperation(
  use: Pick<ConsumerUseIndex, "method" | "normalizedPath">,
  operation: Pick<IndexedOperation, "method" | "normalizedPath">,
): boolean {
  return use.method === operation.method && use.normalizedPath === operation.normalizedPath;
}

export function findOperationForUse(
  use: Pick<ConsumerUseIndex, "method" | "normalizedPath">,
  operations: IndexedOperation[],
): IndexedOperation | undefined {
  return operations.find((operation) => matchesOperation(use, operation));
}

/** Resolve one manifest entry against one service's operations. */
export function resolveUse(use: ConsumerUseIndex, operations: IndexedOperation[]): ResolvedUse {
  const operation = findOperationForUse(use, operations);
  const aliasMap =
    operation === undefined
      ? {}
      : buildParamAliasMap(use.pathTemplate, operation.pathTemplate);

  const rewrite = (paths: string[]): string[] =>
    paths.map((path) => applyParamAlias(path, aliasMap));

  return {
    use,
    operation,
    aliasMap,
    resolvedSends: rewrite(use.sends),
    resolvedReads: rewrite(use.reads),
  };
}

/** Resolve every indexed manifest entry against the given operations per provider. */
export function resolveConsumerIndex(
  index: ConsumerUseIndex[],
  operationsByProvider: Map<string, IndexedOperation[]>,
): ResolvedUse[] {
  return index.map((use) => resolveUse(use, operationsByProvider.get(use.provider) ?? []));
}

/** Operations grouped by provider service name, for consumer resolution. */
export function groupOperationsByProvider(
  operationsByService: Map<string, IndexedOperation[]>,
): Map<string, IndexedOperation[]> {
  return new Map(operationsByService);
}
