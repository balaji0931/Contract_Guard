import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { openDatabase, type Database } from "../src/db/database.js";
import { runStartupPipeline, type StartupResult } from "../src/pipeline/startup.js";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const dirs: string[] = [];
const handles: Array<Database> = [];

let receiver: Server | undefined;
let receiverUrl = "";
let received: Array<{ path: string; body: Record<string, unknown> }> = [];

async function startReceiver(): Promise<string> {
  received = [];
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => receiver?.listen(0, "127.0.0.1", resolve));
  const address = receiver?.address();
  receiverUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  return receiverUrl;
}

beforeAll(async () => {
  await startReceiver();
});

afterAll(async () => {
  await new Promise<void>((resolve) => (receiver ? receiver.close(() => resolve()) : resolve()));
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

afterEach(() => {
  received = [];
});

/** Fresh isolated DB + pinned config, exactly as the acceptance run uses. */
function environment(asOfDate = "2026-11-18"): { db: Database; config: Config } {
  const dir = mkdtempSync(join(tmpdir(), "cg-startup-"));
  dirs.push(dir);
  const config = loadConfig(
    {
      PORT: "5000",
      WEBHOOK_URL: receiverUrl,
      CG_DB_PATH: join(dir, "cg.db"),
      CG_AS_OF_DATE: asOfDate,
      GATE_MODE: "consumer",
      CG_FRESH: "1",
      KIT_ROOT,
    },
    KIT_ROOT,
  );
  const { db } = openDatabase({ path: config.dbPath });
  handles.push(db);
  return { db, config };
}

const FAST = { maxAttempts: 1, baseDelayMs: 5, timeoutMs: 1000 };

function boot(asOfDate = "2026-11-18"): Promise<StartupResult> {
  const { db, config } = environment(asOfDate);
  return runStartupPipeline({ db, config, deliver: FAST });
}

function outcomeMap(result: StartupResult): Map<string, string> {
  return new Map(
    result.decided.map((entry) => [entry.candidate.sourceFile, entry.verdict.outcome]),
  );
}

function gateEvents(db: Database): Array<{ service: string; version: string; outcome: string }> {
  return db
    .prepare(
      "SELECT service, version, outcome FROM events WHERE kind = 'gate_decision' ORDER BY id",
    )
    .all() as never;
}

describe("full startup run, pinned CG_AS_OF_DATE=2026-11-18 (PLAN §7 matrix)", () => {
  // Lazy: must not boot before `beforeAll` has started the receiver.
  let pinned: { db: Database; config: Config } | undefined;
  let runPromise: Promise<StartupResult> | undefined;
  function run(): Promise<StartupResult> {
    if (runPromise === undefined) {
      pinned = environment();
      runPromise = runStartupPipeline({ db: pinned.db, config: pinned.config, deliver: FAST });
    }
    return runPromise;
  }

  it("decides all 12 candidates 5 published / 6 blocked / 1 rejected", async () => {
    const result = await run();
    expect(result.decided).toHaveLength(12);
    expect(result.totals).toEqual({ published: 5, blocked: 6, rejected: 1 });

    const outcomes = outcomeMap(result);
    // claims-api
    expect(outcomes.get("specs/claims-api/1-initial.yaml")).toBe("published");
    expect(outcomes.get("specs/claims-api/2-channel-and-notes.yaml")).toBe("blocked");
    expect(outcomes.get("specs/claims-api/3-channel-and-notes-fixed.yaml")).toBe("rejected");
    expect(outcomes.get("specs/claims-api/4-approval-later.yaml")).toBe("blocked");
    // policy-api
    expect(outcomes.get("specs/policy-api/1-initial.yaml")).toBe("published");
    expect(outcomes.get("specs/policy-api/2-deprecations.yaml")).toBe("published");
    expect(outcomes.get("specs/policy-api/3-remove-old-fields.yaml")).toBe("blocked");
    expect(outcomes.get("specs/policy-api/4-endorsement-rules.yaml")).toBe("blocked");
    // quote-api
    expect(outcomes.get("specs/quote-api/1-initial.yaml")).toBe("published");
    expect(outcomes.get("specs/quote-api/2-reorganised.yaml")).toBe("published");
    expect(outcomes.get("specs/quote-api/3-price-lines.yaml")).toBe("blocked");
    expect(outcomes.get("specs/quote-api/4-ncb-and-taxes.yaml")).toBe("blocked");
  });

  it("processes each service in filename order", async () => {
    const result = await run();
    for (const service of ["claims-api", "policy-api", "quote-api"]) {
      const orders = result.decided
        .filter((entry) => entry.candidate.service === service)
        .map((entry) => entry.candidate.order);
      expect(orders, service).toEqual([...orders].sort((left, right) => left - right));
    }
    // Every service ran files 1..4 in prefix order.
    expect(result.decided.map((entry) => entry.candidate.order)).toEqual([
      1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4,
    ]);
  });

  it("blocks policy 2.0.0 on the past-sunset removal of legacyCode (L-4)", async () => {
    const result = await run();
    const blocked = result.decided.find(
      (entry) => entry.candidate.sourceFile === "specs/policy-api/3-remove-old-fields.yaml",
    );
    expect(blocked?.verdict.reasonCodes).toContain("ERR_SUNSET_REMOVAL_EXPIRED");
  });

  it("never blocks on the future-sunset holder.phone removal (L-4, warning)", async () => {
    const result = await run();
    // No consumer ever gets exposed on holder.phone (nobody reads it)…
    for (const entry of result.decided) {
      expect(
        entry.verdict.impacts.filter((impact) => impact.fieldPath === "holder.phone"),
        entry.candidate.sourceFile,
      ).toEqual([]);
    }
    // …and its removal is not a block reason: policy 2.0.0 blocks only for
    // the past-sunset legacyCode, with holder.phone as a recorded warning.
    const policyBlocked = result.decided.find(
      (entry) => entry.candidate.sourceFile === "specs/policy-api/3-remove-old-fields.yaml",
    );
    expect(policyBlocked?.verdict.reasonCodes).toEqual(["ERR_SUNSET_REMOVAL_EXPIRED"]);
    expect(
      policyBlocked?.verdict.gateFindings.filter(
        (item) => item.code === "WARN_UNCONSUMED_BREAKING" && item.fieldPath === "holder.phone",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("sunset engine flags legacyCode as WARN_SUNSET_OVERDUE for payments-svc", async () => {
    const result = await run();
    const hit = result.sunsetHits.find((candidate) => candidate.fieldPath === "legacyCode");
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({
      service: "policy-api",
      version: "1.1.0",
      fieldPath: "legacyCode",
      sunsetDate: "2026-11-01",
      direction: "reads",
      asOf: "2026-11-18",
    });
    expect(hit?.consumers.map((consumer) => consumer.consumer)).toEqual(["payments-svc"]);
    // holder.phone (sunset 2027-06-30) is NOT overdue.
    expect(result.sunsetHits.find((candidate) => candidate.fieldPath === "holder.phone")).toBeUndefined();
  });

  it("persists the sunset finding on the published row with consumer attribution", async () => {
    await run();
    const findings = pinned?.db
      .prepare(
        `SELECT f.code, f.field_path, c.name AS consumer
         FROM findings f
         JOIN spec_versions sv ON sv.id = f.spec_version_id
         JOIN services s ON s.id = sv.service_id
         LEFT JOIN consumers c ON c.id = f.consumer_id
         WHERE s.name = 'policy-api' AND sv.version = '1.1.0' AND f.code = 'WARN_SUNSET_OVERDUE'`,
      )
      .all() as Array<{ code: string; field_path: string; consumer: string | null }>;
    expect(findings).toEqual([
      expect.objectContaining({
        code: "WARN_SUNSET_OVERDUE",
        field_path: "legacyCode",
        consumer: "payments-svc",
      }),
    ]);
  });

  it("fires the §8 alerts, including sunset-overdue, at the receiver", async () => {
    const result = await run();
    const paths = new Set(result.alerts.map((alert) => alert.webhook_path));
    expect(paths).toContain("/alerts/block/quote-api/2.0.0");
    expect(paths).toContain("/alerts/consumer/mobile-app");
    expect(paths).toContain("/alerts/deprecation/policy-api/1.1.0");
    expect(paths).toContain("/alerts/sunset-overdue/policy-api");
    expect(paths).toContain("/alerts/invalid-spec/claims-api/1.1.0");
    expect(paths).toContain("/alerts/rejected/claims-api/1.1.0");
    expect(result.alerts.every((alert) => alert.status === "sent")).toBe(true);
  });
});

describe("L-4 date-boundary comparisons", () => {
  it("a sunset equal to the as-of date counts as due", async () => {
    const result = await boot("2026-11-01");
    const hit = result.sunsetHits.find((candidate) => candidate.fieldPath === "legacyCode");
    expect(hit?.asOf).toBe("2026-11-01");
  });

  it("one day before the sunset nothing is overdue and the removal is not sunset-blocked", async () => {
    const result = await boot("2026-10-31");
    expect(result.sunsetHits.find((hit) => hit.fieldPath === "legacyCode")).toBeUndefined();
    const blocked = result.decided.find(
      (entry) => entry.candidate.sourceFile === "specs/policy-api/3-remove-old-fields.yaml",
    );
    // Still blocked — payments-svc reads the removed legacyCode — but for the
    // plain field-removal reason, not the past-sunset one.
    expect(blocked?.verdict.outcome).toBe("blocked");
    expect(blocked?.verdict.reasonCodes).not.toContain("ERR_SUNSET_REMOVAL_EXPIRED");
    expect(blocked?.verdict.reasonCodes).toContain("ERR_BREAKING_FIELD_REMOVED");
  });
});

describe("L-3 restart behavior", () => {
  it("replaying on the same DB re-decides identically, re-fires alerts, keeps history", async () => {
    const { db, config } = environment();
    const first = await runStartupPipeline({ db, config, deliver: FAST });
    expect(first.totals).toEqual({ published: 5, blocked: 6, rejected: 1 });
    const firstEvents = gateEvents(db);
    const firstAlerts = db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number };
    const firstReceiverBatch = received.length;
    expect(firstReceiverBatch).toBeGreaterThan(0);

    // Restart twice more on the SAME database.
    const second = await runStartupPipeline({ db, config, deliver: FAST });
    const third = await runStartupPipeline({ db, config, deliver: FAST });

    // Pipeline replays with identical verdicts…
    expect(second.totals).toEqual(first.totals);
    expect(third.totals).toEqual(first.totals);
    expect(outcomeMap(second)).toEqual(outcomeMap(first));

    // …alerts re-fire every launch…
    const alertCount = db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number };
    expect(alertCount.n).toBe(firstAlerts.n * 3);
    expect(received.length).toBe(firstReceiverBatch * 3);
    expect(second.alerts.every((alert) => alert.status === "sent")).toBe(true);

    // …and every prior run stays in the audit history (never deduped away).
    const events = gateEvents(db);
    expect(events).toHaveLength(firstEvents.length * 3);
    expect(events.slice(0, firstEvents.length)).toEqual(firstEvents);
  });

  it("CG_FRESH=0 keeps the decided state and replays nothing", async () => {
    const { db, config } = environment();
    await runStartupPipeline({ db, config, deliver: FAST });
    const eventsBefore = gateEvents(db).length;
    const alertsBefore = (db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }).n;

    const quiet = await runStartupPipeline({
      db,
      config: { ...config, fresh: false },
      deliver: FAST,
    });
    expect(quiet.decided).toEqual([]);
    expect(quiet.alerts).toEqual([]);
    expect(gateEvents(db)).toHaveLength(eventsBefore);
    expect((db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }).n).toBe(
      alertsBefore,
    );

    // Registry state is intact after the skipped run.
    const statuses = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM spec_versions GROUP BY status ORDER BY status`,
      )
      .all() as Array<{ status: string; n: number }>;
    expect(statuses).toEqual(
      expect.arrayContaining([
        { status: "published", n: 5 },
        { status: "blocked", n: 6 },
        { status: "rejected", n: 1 },
      ]),
    );
  });
});
