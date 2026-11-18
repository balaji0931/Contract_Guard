/**
 * Persist intake results (Phase 1 deliverable). Recording is idempotent because
 * locked decision L-3 replays the whole pipeline on every startup: services and
 * consumers upsert, spec-version rows keep the status a previous gate decision
 * gave them, and deterministically-derived findings are replaced rather than
 * duplicated.
 */
import type { Database } from "../db/database.js";
import type { Finding } from "../findings/codes.js";
import type { SpecIntake } from "../loader/specLoader.js";
import type { ConsumerIntake } from "../loader/consumerLoader.js";

export interface IntakeSummary {
  services: number;
  specVersions: number;
  consumers: number;
  consumerUses: number;
  consumerUseFields: number;
  findings: number;
}

function upsertService(db: Database, intake: SpecIntake): number {
  db.prepare(
    `INSERT INTO services (name, title, owner, description)
     VALUES (@name, @title, @owner, @description)
     ON CONFLICT(name) DO UPDATE SET
       title       = COALESCE(excluded.title, services.title),
       owner       = COALESCE(excluded.owner, services.owner),
       description = COALESCE(excluded.description, services.description)`,
  ).run({
    name: intake.service,
    title: intake.title,
    owner: intake.owner,
    description: intake.description,
  });
  return (db.prepare("SELECT id FROM services WHERE name = ?").get(intake.service) as { id: number }).id;
}

function insertFindings(db: Database, specVersionId: number, findings: Finding[]): number {
  // Intake findings are a pure function of the file: replace, never accumulate.
  db.prepare("DELETE FROM findings WHERE spec_version_id = ?").run(specVersionId);
  const insert = db.prepare(
    `INSERT INTO findings (spec_version_id, code, severity, operation_ref, field_path, consumer_id, message)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );
  for (const item of findings) {
    insert.run(
      specVersionId,
      item.code,
      item.severity,
      item.operationRef ?? null,
      item.fieldPath ?? null,
      item.message,
    );
  }
  return findings.length;
}

export function recordIntake(
  db: Database,
  specs: SpecIntake[],
  consumers: ConsumerIntake[],
): IntakeSummary {
  const summary: IntakeSummary = {
    services: 0,
    specVersions: 0,
    consumers: 0,
    consumerUses: 0,
    consumerUseFields: 0,
    findings: 0,
  };

  const record = db.transaction(() => {
    const upsertSpecVersion = db.prepare(
      `INSERT INTO spec_versions
         (service_id, version, status, source_file, content_hash, info_version, title, description, owner)
       VALUES
         (@serviceId, @version, 'staged', @sourceFile, @contentHash, @version, @title, @description, @owner)
       ON CONFLICT(service_id, version, source_file) DO UPDATE SET
         content_hash  = excluded.content_hash,
         info_version  = excluded.info_version,
         title         = COALESCE(excluded.title, spec_versions.title),
         description   = COALESCE(excluded.description, spec_versions.description),
         owner         = COALESCE(excluded.owner, spec_versions.owner)`,
    );
    const specVersionId = db.prepare(
      "SELECT id FROM spec_versions WHERE service_id = ? AND version = ? AND source_file = ?",
    );

    for (const intake of specs) {
      const serviceId = upsertService(db, intake);
      upsertSpecVersion.run({
        serviceId,
        version: intake.version,
        sourceFile: intake.relativePath,
        contentHash: intake.contentHash,
        title: intake.title,
        description: intake.description,
        owner: intake.owner,
      });
      summary.services += 1;
      summary.specVersions += 1;

      const id = (specVersionId.get(serviceId, intake.version, intake.relativePath) as { id: number }).id;
      summary.findings += insertFindings(db, id, intake.issues);
    }

    const upsertConsumer = db.prepare(
      `INSERT INTO consumers (name, team, source_file)
       VALUES (@name, @team, @sourceFile)
       ON CONFLICT(name) DO UPDATE SET
         team = COALESCE(excluded.team, consumers.team),
         source_file = excluded.source_file`,
    );
    const consumerId = db.prepare("SELECT id FROM consumers WHERE name = ?");
    const upsertUse = db.prepare(
      `INSERT INTO consumer_uses (consumer_id, provider, method, path_template, normalized_path)
       VALUES (@consumerId, @provider, @method, @pathTemplate, @normalizedPath)
       ON CONFLICT(consumer_id, provider, method, path_template) DO UPDATE SET
         normalized_path = excluded.normalized_path`,
    );
    const useId = db.prepare(
      `SELECT id FROM consumer_uses
       WHERE consumer_id = @consumerId AND provider = @provider AND method = @method AND path_template = @pathTemplate`,
    );
    const insertField = db.prepare(
      "INSERT INTO consumer_use_fields (use_id, direction, field_path) VALUES (?, ?, ?)",
    );

    for (const intake of consumers) {
      upsertConsumer.run({ name: intake.name, team: intake.team, sourceFile: intake.relativePath });
      const id = (consumerId.get(intake.name) as { id: number }).id;
      summary.consumers += 1;

      for (const use of intake.uses) {
        upsertUse.run({
          consumerId: id,
          provider: use.provider,
          method: use.method,
          pathTemplate: use.pathTemplate,
          normalizedPath: use.normalizedPath,
        });
        const resolvedUseId = (
          useId.get({ consumerId: id, provider: use.provider, method: use.method, pathTemplate: use.pathTemplate }) as {
            id: number;
          }
        ).id;
        summary.consumerUses += 1;

        db.prepare("DELETE FROM consumer_use_fields WHERE use_id = ?").run(resolvedUseId);
        for (const path of use.sends) {
          insertField.run(resolvedUseId, "sends", path);
          summary.consumerUseFields += 1;
        }
        for (const path of use.reads) {
          insertField.run(resolvedUseId, "reads", path);
          summary.consumerUseFields += 1;
        }
      }

      summary.findings += intake.issues.length
        ? insertConsumerFindings(db, intake)
        : 0;
    }
  });

  record();
  return summary;
}

/**
 * Consumer manifests have no spec_version_id to hang a finding on, so manifest
 * problems are recorded as audit events instead of spec findings.
 */
function insertConsumerFindings(db: Database, intake: ConsumerIntake): number {
  const insert = db.prepare(
    "INSERT INTO events (kind, service, version, outcome, detail) VALUES ('consumer_intake', ?, NULL, 'invalid', ?)",
  );
  for (const issue of intake.issues) {
    insert.run(intake.name, JSON.stringify({ code: issue.code, file: intake.relativePath, message: issue.message }));
  }
  return intake.issues.length;
}
