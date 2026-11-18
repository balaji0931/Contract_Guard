/**
 * `POST /api/specs` ingestion (PLAN.md §9): a manual upload runs the exact
 * same pipeline as a kit file — validation, intake persistence, wire index,
 * L-2 dedupe and the publication gate. Nothing is skipped because the spec
 * arrived over HTTP instead of disk; uploads slot in AFTER the service's kit
 * files in publication order.
 */

import type { Database } from "../db/database.js";
import type { Config } from "../config.js";
import { parseYaml, sha256 } from "../loader/readFile.js";
import { validateSpec } from "../validator/specValidator.js";
import { parseOwner, type SpecIntake } from "../loader/specLoader.js";
import { indexOperations } from "../wire/operationIndex.js";
import { recordIntake } from "../registry/intakeStore.js";
import { recordWireIndex } from "../registry/wireStore.js";
import {
  runPublicationGate,
  type GateCandidate,
  type GateVerdict,
} from "../gate/publicationGate.js";
import { dispatchPublicationAlerts, type AlertRecord } from "../notify/notifier.js";
import type { RegistryView } from "./state.js";

export interface UploadBody {
  service?: unknown;
  yaml?: unknown;
}

export type UploadRejection = { status: number; body: Record<string, unknown> };

export interface UploadOutcome {
  specVersionId: number;
  intake: SpecIntake;
  candidate: GateCandidate;
  verdict: GateVerdict;
  alerts: AlertRecord[];
}

function uploadSourceFile(service: string, version: string): string {
  return `api-upload/${service}/${version}.yaml`;
}

/** Parse + validate the upload without touching the database. */
export function parseUpload(
  service: string,
  text: string,
): { ok: true; intake: SpecIntake } | { ok: false; rejection: UploadRejection } {
  const parsed = parseYaml(text);
  if (!parsed.ok) {
    return {
      ok: false,
      rejection: {
        status: 400,
        body: {
          error: "invalid_spec",
          message: `YAML parse error: ${parsed.error}`,
        },
      },
    };
  }

  const info =
    parsed.value !== null && typeof parsed.value === "object"
      ? ((parsed.value as Record<string, unknown>).info as Record<string, unknown> | undefined)
      : undefined;
  const version = typeof info?.version === "string" ? info.version.trim() : "";
  if (version === "") {
    return {
      ok: false,
      rejection: {
        status: 400,
        body: {
          error: "invalid_spec",
          message: "spec must declare info.version",
        },
      },
    };
  }

  const issues = validateSpec(parsed.value);
  const title = typeof info?.title === "string" ? info.title : null;
  const description = typeof info?.description === "string" ? info.description : null;
  const intake: SpecIntake = {
    service,
    order: Number.MAX_SAFE_INTEGER, // replaced by the caller with the real slot
    relativePath: uploadSourceFile(service, version),
    fileName: `${version}.yaml`,
    contentHash: sha256(text),
    version,
    title,
    description,
    owner: parseOwner(description),
    valid: issues.length === 0,
    issues,
    document: parsed.value,
  };
  return { ok: true, intake };
}

/**
 * Persist the upload, run it through the gate, and dispatch the §8 alerts.
 * Throws only on genuine database faults; gate blocks are normal outcomes.
 */
export async function ingestUpload(
  db: Database,
  config: Config,
  view: RegistryView,
  intake: SpecIntake,
): Promise<UploadOutcome> {
  const serviceVersions = view.byService.get(intake.service) ?? [];
  const order =
    serviceVersions.length === 0 ? 1 : Math.max(...serviceVersions.map((v) => v.order)) + 1;
  const candidate: GateCandidate = {
    service: intake.service,
    version: intake.version,
    sourceFile: intake.relativePath,
    order,
    valid: intake.valid,
    intakeFindings: intake.issues,
    operations: intake.valid ? indexOperations(intake.document) : [],
  };

  // Intake + wire index (same stores the startup pipeline uses).
  recordIntake(db, [{ ...intake, order }], []);
  const row = db
    .prepare(
      `SELECT sv.id AS id FROM spec_versions sv JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? AND sv.version = ? AND sv.source_file = ?`,
    )
    .get(intake.service, intake.version, intake.relativePath) as { id: number };
  recordWireIndex(db, row.id, candidate.operations);

  const verdict = runPublicationGate(db, candidate, {
    mode: config.gateMode,
    asOfDate: config.asOfDate,
    consumerIndex: view.index.consumers,
    serviceVersions: [...serviceVersions, candidate],
  });

  const alerts = await dispatchPublicationAlerts(db, config.webhookUrl, {
    service: candidate.service,
    version: candidate.version,
    owner: intake.owner,
    specFile: candidate.sourceFile,
    baselineVersion: verdict.baselineVersion,
    verdict,
    intakeFindings: intake.issues,
    asOfDate: config.asOfDate,
  });

  return { specVersionId: row.id, intake, candidate, verdict, alerts };
}
