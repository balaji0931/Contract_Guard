/**
 * HTTP API (PLAN.md §9). Read endpoints are thin SQLite views over the
 * registry; the action endpoints (`publish`, `specs`, `recheck`) run the SAME
 * engines as startup — a blocked candidate cannot be published over HTTP any
 * more than at startup, and duplicates stay rejected (L-2).
 */

import express, { type Express, type Request, type Response } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/database.js";
import type { Logger } from "../logger.js";
import type { RegistryState } from "./state.js";
import { parseUpload, ingestUpload, type UploadBody } from "./upload.js";
import {
  runPublicationGate,
  type GateCandidate,
} from "../gate/publicationGate.js";
import {
  dispatchPublicationAlerts,
  dispatchSunsetOverdueAlert,
  isoDate,
  retryFailedAlerts,
} from "../notify/notifier.js";
import {
  persistSunsetFindings,
  publishedSnapshotsFrom,
} from "../pipeline/startup.js";
import {
  findOverdueSunsets,
  sunsetFindings,
} from "../sunset/sunsetEngine.js";
import { sunsetExpired } from "../domain/sunsets.js";

export interface ApiDependencies {
  config: Config;
  db: Database;
  logger: Logger;
  state: RegistryState;
}

interface FindingRow {
  id: number;
  code: string;
  severity: string;
  operation_ref: string | null;
  field_path: string | null;
  message: string;
  service: string;
  version: string;
  source_file: string | null;
  consumer: string | null;
}

function queryRows<T>(db: Database, sql: string, params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

function findingRows(db: Database, filters: Record<string, unknown>): FindingRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    where.push(clause);
    params.push(value);
  };
  if (typeof filters.service === "string") add("s.name = ?", filters.service);
  if (typeof filters.version === "string") add("sv.version = ?", filters.version);
  if (typeof filters.code === "string") add("f.code = ?", filters.code);
  if (typeof filters.severity === "string") add("f.severity = ?", filters.severity);
  if (typeof filters.consumer === "string") add("c.name = ?", filters.consumer);

  const sql = `
    SELECT f.id, f.code, f.severity, f.operation_ref, f.field_path, f.message,
           s.name AS service, sv.version, sv.source_file, c.name AS consumer
    FROM findings f
    JOIN spec_versions sv ON sv.id = f.spec_version_id
    JOIN services s ON s.id = sv.service_id
    LEFT JOIN consumers c ON c.id = f.consumer_id
    ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
    ORDER BY s.name, sv.id, f.id
    LIMIT 500`;
  return queryRows<FindingRow>(db, sql, params);
}

function ownerOf(db: Database, service: string): string | null {
  const row = db.prepare("SELECT owner FROM services WHERE name = ?").get(service) as
    | { owner: string | null }
    | undefined;
  return row?.owner ?? null;
}

function serviceExists(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM services WHERE name = ?").get(name) !== undefined;
}

function consumerExists(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM consumers WHERE name = ?").get(name) !== undefined;
}

/** Pick the candidate the endpoint should (re-)decide: highest file order. */
function candidateFor(
  view: { byService: Map<string, GateCandidate[]> },
  service: string,
  version: string,
): GateCandidate | undefined {
  const versions = (view.byService.get(service) ?? []).filter(
    (candidate) => candidate.version === version,
  );
  return versions.at(-1);
}

export function registerApi(app: Express, deps: ApiDependencies): void {
  const { config, db, state } = deps;

  // ---- Registry reads ------------------------------------------------------

  app.get("/api/services", (_req: Request, res: Response) => {
    const services = queryRows<{
      name: string;
      title: string | null;
      owner: string | null;
      description: string | null;
    }>(db, "SELECT name, title, owner, description FROM services ORDER BY name", []);
    const counts = db.prepare(
      `SELECT status, COUNT(*) AS n FROM spec_versions WHERE service_id = ? GROUP BY status`,
    );
    res.json(
      services.map((service) => {
        const row = db.prepare("SELECT id FROM services WHERE name = ?").get(service.name) as {
          id: number;
        };
        const versions = (counts.all(row.id) as Array<{ status: string; n: number }>).map(
          (count) => `${count.status}=${count.n}`,
        );
        const latest = db
          .prepare(
            `SELECT version FROM spec_versions
             WHERE service_id = ? AND status = 'published' ORDER BY id DESC LIMIT 1`,
          )
          .get(row.id) as { version: string } | undefined;
        return {
          ...service,
          latestPublished: latest?.version ?? null,
          versions: versions.sort(),
        };
      }),
    );
  });

  app.get("/api/services/:name/versions", (req: Request, res: Response) => {
    const name = req.params.name as string;
    if (!serviceExists(db, name)) {
      res.status(404).json({ error: "not_found", message: `unknown service ${name}` });
      return;
    }
    const rows = queryRows<{
      id: number;
      version: string;
      status: string;
      source_file: string | null;
      outcome_reason_code: string | null;
      decided_at: string | null;
      owner: string | null;
    }>(
      db,
      `SELECT sv.id, sv.version, sv.status, sv.source_file, sv.outcome_reason_code,
              sv.decided_at, sv.owner
       FROM spec_versions sv JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? ORDER BY sv.source_file`,
      [name],
    );
    res.json(
      rows.map((row) => ({
        ...row,
        reasonCodes:
          row.outcome_reason_code === null || row.outcome_reason_code === ""
            ? []
            : row.outcome_reason_code.split(","),
      })),
    );
  });

  app.get("/api/services/:name/versions/:version", (req: Request, res: Response) => {
    const name = req.params.name as string;
    const version = req.params.version as string;
    const rows = queryRows<{
      id: number;
      version: string;
      status: string;
      source_file: string | null;
      outcome_reason_code: string | null;
      decided_at: string | null;
      content_hash: string | null;
      owner: string | null;
    }>(
      db,
      `SELECT sv.id, sv.version, sv.status, sv.source_file, sv.outcome_reason_code,
              sv.decided_at, sv.content_hash, sv.owner
       FROM spec_versions sv JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? AND sv.version = ? ORDER BY sv.source_file`,
      [name, version],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "not_found", message: `no version ${version} for ${name}` });
      return;
    }
    const findingsFor = db.prepare(
      `SELECT code, severity, operation_ref, field_path, message
       FROM findings WHERE spec_version_id = ? ORDER BY id`,
    );
    res.json({
      service: name,
      version,
      owner: rows[0]?.owner ?? ownerOf(db, name),
      attempts: rows.map((row) => ({
        ...row,
        reasonCodes:
          row.outcome_reason_code === null || row.outcome_reason_code === ""
            ? []
            : row.outcome_reason_code.split(","),
        findings: findingsFor.all(row.id),
      })),
    });
  });

  app.get("/api/services/:name/versions/:version/impact", (req: Request, res: Response) => {
    const name = req.params.name as string;
    const version = req.params.version as string;
    const rows = queryRows<{ id: number; status: string; outcome_reason_code: string | null }>(
      db,
      `SELECT sv.id, sv.status, sv.outcome_reason_code
       FROM spec_versions sv JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? AND sv.version = ?`,
      [name, version],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "not_found", message: `no version ${version} for ${name}` });
      return;
    }
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    const attributed = queryRows<{
      consumer: string;
      team: string | null;
      code: string;
      severity: string;
      operation_ref: string | null;
      field_path: string | null;
      message: string;
    }>(
      db,
      `SELECT c.name AS consumer, c.team, f.code, f.severity, f.operation_ref,
              f.field_path, f.message
       FROM findings f
       JOIN consumers c ON c.id = f.consumer_id
       WHERE f.spec_version_id IN (${placeholders})
       ORDER BY c.name, f.id`,
      ids,
    );
    const grouped = new Map<string, { team: string | null; issues: unknown[] }>();
    for (const item of attributed) {
      const bucket = grouped.get(item.consumer) ?? { team: item.team, issues: [] };
      bucket.issues.push(item);
      grouped.set(item.consumer, bucket);
    }
    res.json({
      service: name,
      version,
      statuses: rows.map((row) => row.status),
      reasonCodes: [
        ...new Set(
          rows.flatMap((row) =>
            row.outcome_reason_code === null || row.outcome_reason_code === ""
              ? []
              : row.outcome_reason_code.split(","),
          ),
        ),
      ],
      impactedConsumers: [...grouped.entries()].map(([consumer, bucket]) => ({
        consumer,
        team: bucket.team,
        issues: bucket.issues,
      })),
    });
  });

  // ---- Actions (same gate, same rules) --------------------------------------

  app.post(
    "/api/services/:name/versions/:version/publish",
    async (req: Request, res: Response) => {
      const name = req.params.name as string;
      const version = req.params.version as string;
      const view = state.view(db, config);
      const candidate = candidateFor(view, name, version);
      if (candidate === undefined) {
        res.status(404).json({
          error: "not_found",
          message: `no candidate ${name} ${version} in the registry (kit scan + uploads)`,
        });
        return;
      }

      const verdict = runPublicationGate(db, candidate, {
        mode: config.gateMode,
        asOfDate: config.asOfDate,
        consumerIndex: view.index.consumers,
        serviceVersions: view.byService.get(name) ?? [],
      });
      await dispatchPublicationAlerts(
        db,
        config.webhookUrl,
        {
          service: name,
          version,
          owner: ownerOf(db, name),
          specFile: candidate.sourceFile,
          baselineVersion: verdict.baselineVersion,
          verdict,
          intakeFindings: candidate.intakeFindings,
          asOfDate: config.asOfDate,
        },
      );

      res.json({
        service: name,
        version,
        outcome: verdict.outcome,
        reasonCodes: verdict.reasonCodes,
        baselineVersion: verdict.baselineVersion,
        impactedConsumers: [...new Set(verdict.impacts.map((impact) => impact.consumer))],
        note:
          verdict.outcome === "blocked"
            ? "the gate blocked this publication; fix the breaking change or its consumer first"
            : verdict.outcome === "rejected"
              ? "the version number is reserved (L-2); publish under a new number"
              : "published",
      });
    },
  );

  app.post("/api/specs", async (req: Request, res: Response) => {
    const body = req.body as UploadBody;
    if (typeof body?.service !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.service)) {
      res.status(400).json({ error: "invalid_request", message: "`service` is required" });
      return;
    }
    if (typeof body.yaml !== "string" || body.yaml.trim() === "") {
      res.status(400).json({ error: "invalid_request", message: "`yaml` must be a non-empty string" });
      return;
    }

    const parsed = parseUpload(body.service, body.yaml);
    if (!parsed.ok) {
      res.status(parsed.rejection.status).json(parsed.rejection.body);
      return;
    }

    const view = state.view(db, config);
    const outcome = await ingestUpload(db, config, view, parsed.intake);
    // Remember the candidate so the gate can use/diff against it this process.
    state.addUpload(outcome.candidate);

    res.status(201).json({
      service: parsed.intake.service,
      version: parsed.intake.version,
      sourceFile: parsed.intake.relativePath,
      valid: parsed.intake.valid,
      intakeFindings: parsed.intake.issues,
      outcome: outcome.verdict.outcome,
      reasonCodes: outcome.verdict.reasonCodes,
      baselineVersion: outcome.verdict.baselineVersion,
      impactedConsumers: [...new Set(outcome.verdict.impacts.map((impact) => impact.consumer))],
    });
  });

  // ---- Consumers, findings, alerts, events -----------------------------------

  app.get("/api/consumers", (_req: Request, res: Response) => {
    const consumers = queryRows<{ id: number; name: string; team: string | null }>(
      db,
      "SELECT id, name, team FROM consumers ORDER BY name",
      [],
    );
    const uses = queryRows<{
      consumer_id: number;
      provider: string;
      method: string;
      path_template: string;
    }>(
      db,
      `SELECT cu.consumer_id, cu.provider, cu.method, cu.path_template
       FROM consumer_uses cu ORDER BY cu.provider, cu.method, cu.path_template`,
      [],
    );
    const issueCounts = new Map<number, number>(
      queryRows<{ consumer_id: number; n: number }>(
        db,
        `SELECT consumer_id, COUNT(*) AS n FROM findings
         WHERE consumer_id IS NOT NULL GROUP BY consumer_id`,
        [],
      ).map((row) => [row.consumer_id, row.n]),
    );
    res.json(
      consumers.map((consumer) => ({
        name: consumer.name,
        team: consumer.team,
        uses: uses
          .filter((use) => use.consumer_id === consumer.id)
          .map((use) => ({ provider: use.provider, method: use.method, path: use.path_template })),
        openIssues: issueCounts.get(consumer.id) ?? 0,
      })),
    );
  });

  app.get("/api/consumers/:name/risks", (req: Request, res: Response) => {
    const name = req.params.name as string;
    if (!consumerExists(db, name)) {
      res.status(404).json({ error: "not_found", message: `unknown consumer ${name}` });
      return;
    }
    const issues = findingRows(db, { consumer: name });
    const uses = queryRows<{ provider: string; method: string; path_template: string }>(
      db,
      `SELECT cu.provider, cu.method, cu.path_template
       FROM consumer_uses cu JOIN consumers c ON c.id = cu.consumer_id
       WHERE c.name = ?`,
      [name],
    );
    res.json({
      consumer: name,
      exposed: issues.length > 0,
      issues: issues.map((issue) => ({
        service: issue.service,
        version: issue.version,
        code: issue.code,
        severity: issue.severity,
        operationRef: issue.operation_ref,
        fieldPath: issue.field_path,
        message: issue.message,
      })),
      uses,
    });
  });

  app.get("/api/findings", (req: Request, res: Response) => {
    res.json(findingRows(db, req.query as Record<string, unknown>));
  });

  app.get("/api/alerts", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const alerts = queryRows<Record<string, unknown>>(
      db,
      "SELECT id, webhook_path, status, attempts, http_status, last_error, created_at, sent_at FROM alerts ORDER BY id DESC LIMIT ?",
      [limit],
    );
    res.json(alerts);
  });

  app.get("/api/events", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const events = queryRows<Record<string, unknown>>(
      db,
      `SELECT id, occurred_at, kind, service, version, outcome, detail FROM events
       ${kind === undefined ? "" : "WHERE kind = ?"} ORDER BY id DESC LIMIT ?`,
      kind === undefined ? [limit] : [kind, limit],
    );
    res.json(events);
  });

  // ---- Re-check (PLAN §5: sunset engine runs at startup and on recheck) -----

  app.post("/api/recheck", async (_req: Request, res: Response) => {
    const view = state.view(db, config);
    const published = publishedSnapshotsFrom(db, view.candidates);
    const hits = findOverdueSunsets({
      published,
      consumerIndex: view.index.consumers,
      asOfDate: config.asOfDate,
    });
    persistSunsetFindings(db, published, hits);

    const sunsetAlerts = [];
    const byService = new Map<string, typeof hits>();
    for (const hit of hits) {
      byService.set(hit.service, [...(byService.get(hit.service) ?? []), hit]);
    }
    for (const [service, serviceHits] of byService) {
      const snapshot = published.find((item) => item.service === service);
      if (snapshot === undefined) continue;
      sunsetAlerts.push(
        await dispatchSunsetOverdueAlert(
          db,
          config.webhookUrl,
          {
            service,
            owner: snapshot.owner,
            specFile: snapshot.sourceFile,
            version: snapshot.version,
            findings: sunsetFindings(serviceHits),
            asOfDate: config.asOfDate,
          },
        ),
      );
    }

    const retry = await retryFailedAlerts(db, config.webhookUrl);
    res.json({
      asOf: isoDate(config.asOfDate),
      sunsetOverdue: hits.map((hit) => ({
        service: hit.service,
        version: hit.version,
        operationRef: hit.operationRef,
        fieldPath: hit.fieldPath,
        sunsetDate: hit.sunsetDate,
        overdue: sunsetExpired(hit.sunsetDate, config.asOfDate),
        consumers: hit.consumers.map((consumer) => consumer.consumer),
      })),
      sunsetAlerts: sunsetAlerts.map((alert) => ({ id: alert.id, status: alert.status })),
      retriedAlerts: retry,
    });
  });
}
