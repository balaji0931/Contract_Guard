/**
 * Persist the wire index for a spec version (PLAN.md §5: `operations` and
 * `wire_fields`). Re-indexing replaces the previous rows for that version, so a
 * startup replay under L-3 never accumulates duplicates.
 */
import type { Database } from "../db/database.js";
import type { IndexedOperation } from "../wire/operationIndex.js";
import type { WireField } from "../wire/schemaWalker.js";

export interface WireIndexSummary {
  operations: number;
  fields: number;
}

function insertFields(db: Database, operationId: number, fields: WireField[]): number {
  const insert = db.prepare(
    `INSERT INTO wire_fields
       (operation_id, direction, status_code, field_path, type, format, required, enum_values, deprecated, sunset_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  for (const field of fields) {
    insert.run(
      operationId,
      field.direction,
      field.statusCode,
      field.path,
      field.type,
      field.format,
      field.required ? 1 : 0,
      field.enumValues === null ? null : JSON.stringify(field.enumValues),
      field.deprecated ? 1 : 0,
      field.sunsetDate,
    );
    count += 1;
  }
  return count;
}

export function recordWireIndex(
  db: Database,
  specVersionId: number,
  operations: IndexedOperation[],
): WireIndexSummary {
  const summary: WireIndexSummary = { operations: 0, fields: 0 };

  const write = db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM operations WHERE spec_version_id = ?")
      .all(specVersionId) as Array<{ id: number }>;
    for (const row of existing) {
      db.prepare("DELETE FROM wire_fields WHERE operation_id = ?").run(row.id);
    }
    db.prepare("DELETE FROM operations WHERE spec_version_id = ?").run(specVersionId);

    const insertOperation = db.prepare(
      `INSERT INTO operations (spec_version_id, method, path_template, normalized_path, operation_id, summary, is_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const operation of operations) {
      const result = insertOperation.run(
        specVersionId,
        operation.method,
        operation.pathTemplate,
        operation.normalizedPath,
        operation.operationId,
        operation.summary,
        operation.isInternal ? 1 : 0,
      );
      const operationId = Number(result.lastInsertRowid);
      summary.operations += 1;
      summary.fields += insertFields(
        db,
        operationId,
        allOperationFields(operation),
      );
    }
  });

  write();
  return summary;
}

/** Request fields plus every response group, in the shape `wire_fields` stores. */
function allOperationFields(operation: IndexedOperation): WireField[] {
  return [...operation.requestFields, ...operation.responseFieldsByStatus.flatMap((g) => g.fields)];
}
