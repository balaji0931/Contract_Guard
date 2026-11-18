/**
 * Notifier (PLAN.md §8, L-6). POSTs JSON alerts to `WEBHOOK_URL` + the §8
 * path, records every attempt in the `alerts` table, and retries with
 * exponential backoff. It runs strictly AFTER the gate transaction has
 * committed: delivery failure never changes a verdict, never unblocks a
 * blocked version, and never crashes the gate — an unavailable receiver just
 * leaves `failed` rows that `retryFailedAlerts` can resend.
 *
 * §8 paths:
 *   /alerts/block/{service}/{version}              blocked publication summary
 *   /alerts/consumer/{consumer}                    one message per affected consumer
 *   /alerts/deprecation/{service}/{version}        field newly deprecated + sunset
 *   /alerts/sunset-overdue/{service}               sunset passed, field consumed
 *   /alerts/invalid-spec/{service}/{version}       spec failed validation
 *   /alerts/rejected/{service}/{version}           duplicate version at intake
 *
 * Payload shape (PLAN.md §8 sketch, plus `consumer`/`team` on consumer alerts
 * so a team can tell its own message apart): `{ event, service, owner,
 * from_version, to_version, action, verdict, findings[], spec_file, as_of,
 * occurred_at }`.
 */

import type { Database } from "../db/database.js";
import type { Finding, FindingCode } from "../findings/codes.js";
import type { GateVerdict } from "../gate/publicationGate.js";
import type { ConsumerImpact } from "../impact/consumerImpact.js";

export interface AlertFinding {
  code: FindingCode;
  severity: string;
  message: string;
  operation_ref?: string;
  field_path?: string;
}

export interface AlertPayload {
  event: string;
  service: string;
  owner: string | null;
  from_version: string | null;
  to_version: string | null;
  action: string;
  verdict: string;
  findings: AlertFinding[];
  spec_file: string | null;
  as_of: string;
  occurred_at: string;
  /** Only on `/alerts/consumer/{consumer}` messages. */
  consumer?: string;
  team?: string | null;
}

export interface DeliverOptions {
  /** Total attempts per delivery cycle, including the first. */
  maxAttempts?: number;
  /** First backoff step; doubles per retry. */
  baseDelayMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface AlertRecord {
  id: number;
  webhook_path: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  http_status: number | null;
  last_error: string | null;
}

const DEFAULTS = { maxAttempts: 3, baseDelayMs: 250, timeoutMs: 5000 } as const;

/** §8 paths, kept in one place so callers never hand-build URLs. */
export const alertPaths = {
  block: (service: string, version: string) => `/alerts/block/${service}/${version}`,
  consumer: (consumer: string) => `/alerts/consumer/${consumer}`,
  deprecation: (service: string, version: string) =>
    `/alerts/deprecation/${service}/${version}`,
  sunsetOverdue: (service: string) => `/alerts/sunset-overdue/${service}`,
  invalidSpec: (service: string, version: string) =>
    `/alerts/invalid-spec/${service}/${version}`,
  rejected: (service: string, version: string) => `/alerts/rejected/${service}/${version}`,
} as const;

function toAlertFinding(item: Finding): AlertFinding {
  return {
    code: item.code,
    severity: item.severity,
    message: item.message,
    ...(item.operationRef === undefined ? {} : { operation_ref: item.operationRef }),
    ...(item.fieldPath === undefined ? {} : { field_path: item.fieldPath }),
  };
}

function impactToFinding(impact: ConsumerImpact): AlertFinding {
  return {
    code: impact.code,
    severity: impact.severity,
    message: impact.message,
    operation_ref: impact.operationRef,
    ...(impact.fieldPath === null ? {} : { field_path: impact.fieldPath }),
  };
}

/** The pinned calendar date used for L-4 comparisons, ISO formatted. */
export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AttemptOutcome {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
}

async function attemptDelivery(
  webhookUrl: string,
  path: string,
  payload: AlertPayload,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  try {
    const response = await fetch(new URL(path, webhookUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return { ok: false, httpStatus: response.status, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, httpStatus: response.status, error: null };
  } catch (error) {
    return { ok: false, httpStatus: null, error: (error as Error).message.slice(0, 400) };
  }
}

/**
 * Deliver one alert with retry + backoff. The `alerts` row is inserted before
 * the first attempt, so even a crash mid-delivery leaves evidence. Never
 * throws: the final row state is the only report.
 */
export async function deliverAlert(
  db: Database,
  webhookUrl: string,
  path: string,
  payload: AlertPayload,
  options: DeliverOptions = {},
): Promise<AlertRecord> {
  const { maxAttempts, baseDelayMs, timeoutMs } = { ...DEFAULTS, ...options };

  const insert = db
    .prepare("INSERT INTO alerts (webhook_path, payload, status, attempts) VALUES (?, ?, 'pending', 0)")
    .run(path, JSON.stringify(payload));
  const alertId = Number(insert.lastInsertRowid);

  let attempts = 0;
  let last: AttemptOutcome = { ok: false, httpStatus: null, error: "no attempt made" };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) await sleep(baseDelayMs * 2 ** (attempt - 2));
    attempts += 1;
    last = await attemptDelivery(webhookUrl, path, payload, timeoutMs);
    if (last.ok) break;
  }

  const status = last.ok ? "sent" : "failed";
  db.prepare(
    `UPDATE alerts
     SET status = ?, attempts = ?, http_status = ?, last_error = ?,
         sent_at = CASE WHEN ? = 'sent' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
     WHERE id = ?`,
  ).run(status, attempts, last.httpStatus, last.error, status, alertId);

  return { id: alertId, webhook_path: path, status, attempts, http_status: last.httpStatus, last_error: last.error };
}

/**
 * Resend every `failed` alert (PLAN §5: retries never change gate outcomes).
 * Used by re-checks and the dashboard; returns counts per outcome.
 */
export async function retryFailedAlerts(
  db: Database,
  webhookUrl: string,
  options: DeliverOptions = {},
): Promise<{ retried: number; sent: number; failed: number }> {
  const failed = db
    .prepare("SELECT id, webhook_path, payload FROM alerts WHERE status = 'failed' ORDER BY id")
    .all() as Array<{ id: number; webhook_path: string; payload: string }>;

  const { maxAttempts, baseDelayMs, timeoutMs } = { ...DEFAULTS, ...options };
  const result = { retried: 0, sent: 0, failed: 0 };

  for (const row of failed) {
    result.retried += 1;
    let attemptsBefore = (
      db.prepare("SELECT attempts FROM alerts WHERE id = ?").get(row.id) as { attempts: number }
    ).attempts;

    let last: AttemptOutcome = { ok: false, httpStatus: null, error: "no attempt made" };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) await sleep(baseDelayMs * 2 ** (attempt - 2));
      attemptsBefore += 1;
      last = await attemptDelivery(webhookUrl, row.webhook_path, JSON.parse(row.payload) as AlertPayload, timeoutMs);
      db.prepare("UPDATE alerts SET attempts = ? WHERE id = ?").run(attemptsBefore, row.id);
      if (last.ok) break;
    }

    const status = last.ok ? "sent" : "failed";
    db.prepare(
      `UPDATE alerts
       SET status = ?, http_status = ?, last_error = ?,
           sent_at = CASE WHEN ? = 'sent' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
       WHERE id = ?`,
    ).run(status, last.httpStatus, last.error, status, row.id);
    result[status] += 1;
  }

  return result;
}

/** Everything the pipeline knows about the publication that just got a verdict. */
export interface PublicationAlertInput {
  service: string;
  version: string;
  owner: string | null;
  specFile: string;
  /** The baseline the gate diffed against, `null` for a first version. */
  baselineVersion: string | null;
  verdict: GateVerdict;
  /** Validation findings from intake (used by the invalid-spec alert). */
  intakeFindings: Finding[];
  asOfDate: Date;
}

/**
 * Send the §8 alerts that a gate verdict requires: blocked → summary +
 * per-consumer (+ invalid-spec when validity caused it); rejected → rejection
 * note; published with new deprecations → deprecation notice. Returns the
 * alert rows for logging; individual failures are recorded, never thrown.
 */
export async function dispatchPublicationAlerts(
  db: Database,
  webhookUrl: string,
  input: PublicationAlertInput,
  options: DeliverOptions = {},
): Promise<AlertRecord[]> {
  const { verdict } = input;
  const base = {
    service: input.service,
    owner: input.owner,
    from_version: input.baselineVersion,
    to_version: input.version,
    spec_file: input.specFile,
    as_of: isoDate(input.asOfDate),
    occurred_at: new Date().toISOString(),
  };
  const sent: AlertRecord[] = [];

  if (verdict.outcome === "blocked") {
    const blocking = verdict.diffFindings.filter((item) => item.severity === "blocking");
    const invalid = verdict.reasonCodes.includes("ERR_INVALID_SPEC");

    if (invalid) {
      sent.push(
        await deliverAlert(db, webhookUrl, alertPaths.invalidSpec(input.service, input.version), {
          ...base,
          event: "invalid_spec",
          action: "fix_spec",
          verdict: "blocked",
          findings: input.intakeFindings.map(toAlertFinding),
        }, options),
      );
    }

    sent.push(
      await deliverAlert(db, webhookUrl, alertPaths.block(input.service, input.version), {
        ...base,
        event: "publication_blocked",
        action: invalid ? "fix_spec" : "block",
        verdict: "blocked",
        findings: (invalid ? input.intakeFindings : blocking).map(toAlertFinding),
      }, options),
    );

    // One message per affected consumer, straight from the verdict's impacts.
    const byConsumer = new Map<string, { team: string | null; issues: ConsumerImpact[] }>();
    for (const impact of verdict.impacts) {
      const exposure = byConsumer.get(impact.consumer) ?? { team: impact.team, issues: [] };
      exposure.issues.push(impact);
      byConsumer.set(impact.consumer, exposure);
    }
    for (const [consumer, exposure] of [...byConsumer.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      sent.push(
        await deliverAlert(
          db,
          webhookUrl,
          alertPaths.consumer(consumer),
          {
            ...base,
            event: "consumer_impact",
            action: "your_call_breaks",
            verdict: "blocked",
            consumer,
            team: exposure.team,
            findings: exposure.issues.map(impactToFinding),
          },
          options,
        ),
      );
    }
    return sent;
  }

  if (verdict.outcome === "rejected") {
    sent.push(
      await deliverAlert(db, webhookUrl, alertPaths.rejected(input.service, input.version), {
        ...base,
        event: "version_rejected",
        action: "republish_under_next_version",
        verdict: "rejected",
        findings: verdict.gateFindings.map(toAlertFinding),
      }, options),
    );
    return sent;
  }

  // Published: deprecation notices ride along when the diff introduced them.
  const deprecated = verdict.diffFindings.filter((item) => item.code === "WARN_DEPRECATED_FIELD");
  if (deprecated.length > 0) {
    sent.push(
      await deliverAlert(db, webhookUrl, alertPaths.deprecation(input.service, input.version), {
        ...base,
        event: "field_deprecated",
        action: "plan_removal",
        verdict: "published",
        findings: deprecated.map(toAlertFinding),
      }, options),
    );
  }
  return sent;
}

/**
 * Sunset-overdue alert (PLAN §8): a field whose `x-sunset` has passed is still
 * present and still consumed. Emitted by the startup sunset engine (Phase 7).
 */
export async function dispatchSunsetOverdueAlert(
  db: Database,
  webhookUrl: string,
  input: {
    service: string;
    owner: string | null;
    specFile: string;
    version: string;
    findings: Finding[];
    asOfDate: Date;
  },
  options: DeliverOptions = {},
): Promise<AlertRecord> {
  return deliverAlert(
    db,
    webhookUrl,
    alertPaths.sunsetOverdue(input.service),
    {
      event: "sunset_overdue",
      service: input.service,
      owner: input.owner,
      from_version: null,
      to_version: input.version,
      action: "remove_after_sunset",
      verdict: "warning",
      findings: input.findings.map(toAlertFinding),
      spec_file: input.specFile,
      as_of: isoDate(input.asOfDate),
      occurred_at: new Date().toISOString(),
    },
    options,
  );
}
