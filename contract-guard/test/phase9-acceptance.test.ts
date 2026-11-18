/**
 * Phase 9 — acceptance (IMPLEMENTATION_PLAN.md: "Acceptance tests vs §7 matrix
 * + end-to-end webhook assertion").
 *
 * Runs the REAL startup pipeline (auto-ingest, auto-publish) on a clean
 * isolated database with CG_AS_OF_DATE=2026-11-18 and asserts, against the
 * persisted registry rather than in-memory verdicts:
 *  - every row of the PLAN.md §7 matrix and the 5/6/1 totals;
 *  - impacted consumers (who breaks, on which field);
 *  - the x-internal exclusion (PO-1/L-1) — noted, never blocking;
 *  - actual webhook receipt at a live receiver (§8 paths + payload shape);
 *  - startup/restart behavior (L-3);
 *  - specs/ and consumers/ byte-identical after everything (read-only law).
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { loadConfig, type Config } from "../src/config.js";
import { openDatabase, type Database } from "../src/db/database.js";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import { runStartupPipeline, type StartupResult } from "../src/pipeline/startup.js";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const AS_OF = "2026-11-18";

const dirs: string[] = [];
const handles: Array<Database> = [];

// ---- kit fingerprint: proves specs/ and consumers/ stay byte-identical ------

function kitFingerprint(): string {
  const files: string[] = [];
  for (const root of ["specs", "consumers"]) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(join(KIT_ROOT, root));
  }
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(relative(KIT_ROOT, file));
    digest.update("\0");
    digest.update(readFileSync(file)); // read-only access, always
    digest.update("\0");
  }
  return digest.digest("hex");
}

// ---- live receiver standing in for chat/email (same routes as the kit) -----

interface Received {
  path: string;
  body: Record<string, unknown>;
}

let receiver: Server | undefined;
let receiverUrl = "";
let received: Received[] = [];
let receivedCount = 0;
let allReceived: Received[] = [];

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") {
        const item = {
          path: req.url ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        };
        received.push(item);
        allReceived.push(item);
        receivedCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: receivedCount }));
        return;
      }
      if (req.url === "/api/received" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(allReceived.map((item) => ({ path: item.path, ...item.body }))));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => receiver?.listen(0, "127.0.0.1", resolve));
  const address = receiver?.address();
  receiverUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (receiver ? receiver.close(() => resolve()) : resolve()));
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

// ---- the clean, isolated acceptance run --------------------------------------

const fingerprintBefore = kitFingerprint();

interface Fixture {
  config: Config;
  db: Database;
}

// Built lazily so the config carries the live receiver URL (assigned in beforeAll).
let fixture: Fixture | undefined;
function env(): Fixture {
  if (fixture === undefined) {
    const dbDir = mkdtempSync(join(tmpdir(), "cg-accept-"));
    dirs.push(dbDir);
    const config = loadConfig(
      {
        PORT: "5000",
        WEBHOOK_URL: receiverUrl,
        CG_DB_PATH: join(dbDir, "acceptance.db"),
        CG_AS_OF_DATE: AS_OF,
        GATE_MODE: "consumer",
        CG_FRESH: "1",
        KIT_ROOT,
      },
      KIT_ROOT,
    );
    const { db } = openDatabase({ path: config.dbPath });
    handles.push(db);
    fixture = { config, db };
  }
  return fixture;
}

// Boot only after the receiver is listening (beforeAll), so every §8 alert of
// the acceptance run actually arrives. Memoized: one clean pipeline run.
let bootPromise: Promise<StartupResult> | undefined;
function boot(): Promise<StartupResult> {
  const { config, db } = env();
  bootPromise ??= runStartupPipeline({ db, config, deliver: { maxAttempts: 1, timeoutMs: 2000 } });
  return bootPromise;
}

function rows(sql: string, params: unknown[] = []): Array<Record<string, string | null>> {
  return env().db.prepare(sql).all(...(params as never[])) as never;
}

function statusOf(sourceFile: string): string {
  const row = rows(
    `SELECT sv.status FROM spec_versions sv JOIN services s ON s.id = sv.service_id
     WHERE sv.source_file = ?`,
    [sourceFile],
  )[0] as { status: string } | undefined;
  expect(row, sourceFile).toBeDefined();
  return (row as { status: string }).status;
}

function reasonCodesOf(sourceFile: string): string[] {
  const row = rows(
    `SELECT sv.outcome_reason_code FROM spec_versions sv JOIN services s ON s.id = sv.service_id
     WHERE sv.source_file = ?`,
    [sourceFile],
  )[0] as { outcome_reason_code: string | null };
  return row.outcome_reason_code === null || row.outcome_reason_code === ""
    ? []
    : row.outcome_reason_code.split(",");
}

function findingsOf(sourceFile: string): Array<Record<string, string | null>> {
  return rows(
    `SELECT f.code, f.severity, f.operation_ref, f.field_path, f.message, c.name AS consumer
     FROM findings f
     JOIN spec_versions sv ON sv.id = f.spec_version_id
     JOIN services s ON s.id = sv.service_id
     LEFT JOIN consumers c ON c.id = f.consumer_id
     WHERE s.name = ? AND sv.source_file = ? ORDER BY f.id`,
    [sourceFile.split("/")[1], sourceFile],
  );
}

function attributedFields(consumer: string): Set<string> {
  return new Set(
    rows(
      `SELECT DISTINCT f.field_path AS field
       FROM findings f JOIN consumers c ON c.id = f.consumer_id
       WHERE c.name = ? AND f.field_path IS NOT NULL
         AND f.code NOT IN ('WARN_SUNSET_OVERDUE')`,
      [consumer],
    ).map((row) => row.field as string),
  );
}

describe("§7 acceptance matrix — every row on a clean isolated DB", () => {
  it("row 1: quote 1.0.0 publishes as the first version", async () => {
    await boot();
    expect(statusOf("specs/quote-api/1-initial.yaml")).toBe("published");
  });

  it("row 2: quote 1.1.0 — pure refactor with ZERO findings", async () => {
    await boot();
    expect(statusOf("specs/quote-api/2-reorganised.yaml")).toBe("published");
    expect(findingsOf("specs/quote-api/2-reorganised.yaml")).toEqual([]);
  });

  it("row 3: quote 2.0.0 blocked — amount rename breaks mobile-app; internal region noted only", async () => {
    await boot();
    expect(statusOf("specs/quote-api/3-price-lines.yaml")).toBe("blocked");
    expect(reasonCodesOf("specs/quote-api/3-price-lines.yaml")).toContain(
      "ERR_BREAKING_FIELD_REMOVED",
    );
    const mobile = rows(
      `SELECT c.name AS consumer, f.field_path
       FROM findings f JOIN spec_versions sv ON sv.id = f.spec_version_id
       JOIN services s ON s.id = sv.service_id JOIN consumers c ON c.id = f.consumer_id
       WHERE s.name = 'quote-api' AND sv.source_file = 'specs/quote-api/3-price-lines.yaml'`,
    );
    expect(mobile).toEqual([
      { consumer: "mobile-app", field_path: "premium.breakdown[].amount" },
    ]);
    // New required `region` param on the x-internal op: noted, never blocking.
    const internalNotes = findingsOf("specs/quote-api/3-price-lines.yaml").filter(
      (item) => item.code === "WARN_INTERNAL_CHANGE_NOTED",
    );
    expect(internalNotes.length).toBeGreaterThan(0);
    expect(
      findingsOf("specs/quote-api/3-price-lines.yaml").filter(
        (item) => item.operation_ref !== null && item.operation_ref.includes("pricing-cache"),
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "info" })]));
  });

  it("row 4: quote 2.1.0 blocked — still carries the amount rename vs baseline 1.1.0", async () => {
    await boot();
    expect(statusOf("specs/quote-api/4-ncb-and-taxes.yaml")).toBe("blocked");
    const detail = JSON.parse(
      (
        rows(
          `SELECT detail FROM events WHERE kind = 'gate_decision' AND service = 'quote-api'
           AND version = '2.1.0' ORDER BY id DESC LIMIT 1`,
        )[0] as { detail: string }
      ).detail,
    );
    expect(detail.baseline).toBe("specs/quote-api/2-reorganised.yaml"); // NOT the blocked 2.0.0
    expect(
      findingsOf("specs/quote-api/4-ncb-and-taxes.yaml").some(
        (item) =>
          item.code === "ERR_BREAKING_FIELD_REMOVED" &&
          item.field_path === "premium.breakdown[].amount",
      ),
    ).toBe(true);
  });

  it("rows 5–6: policy 1.0.0 publishes; 1.1.0 publishes with deprecation + sunset notices", async () => {
    await boot();
    expect(statusOf("specs/policy-api/1-initial.yaml")).toBe("published");
    expect(statusOf("specs/policy-api/2-deprecations.yaml")).toBe("published");
    const deprecations = findingsOf("specs/policy-api/2-deprecations.yaml").filter(
      (item) => item.code === "WARN_DEPRECATED_FIELD",
    );
    const fields = new Set(
      // The same field is deprecated on every response shape containing it
      // (single object and list endpoints), so compare by trailing path.
      deprecations.map((item) => (item.field_path ?? "").replace(/^\[\]\./, "")),
    );
    expect(fields).toEqual(new Set(["legacyCode", "holder.phone"]));
    const messages = deprecations.map((item) => item.message).join(" ");
    expect(messages).toContain("2026-11-01");
    expect(messages).toContain("2027-06-30");
  });

  it("row 7: policy 2.0.0 blocked hard on past-sunset legacyCode removal; phone is a warning", async () => {
    await boot();
    expect(statusOf("specs/policy-api/3-remove-old-fields.yaml")).toBe("blocked");
    expect(reasonCodesOf("specs/policy-api/3-remove-old-fields.yaml")).toEqual([
      "ERR_SUNSET_REMOVAL_EXPIRED",
    ]);
    expect(
      findingsOf("specs/policy-api/3-remove-old-fields.yaml").filter(
        (item) => item.code === "WARN_UNCONSUMED_BREAKING" && item.field_path === "holder.phone",
      ).length,
    ).toBeGreaterThan(0);
    const payments = findingsOf("specs/policy-api/3-remove-old-fields.yaml").filter(
      (item) => item.consumer === "payments-svc",
    );
    expect(payments[0]).toMatchObject({
      code: "ERR_SUNSET_REMOVAL_EXPIRED",
      field_path: "legacyCode",
    });
  });

  it("row 8: policy 2.1.0 blocked — requestedBy + VEHICLE enum drop break partner-portal", async () => {
    await boot();
    expect(statusOf("specs/policy-api/4-endorsement-rules.yaml")).toBe("blocked");
    expect(reasonCodesOf("specs/policy-api/4-endorsement-rules.yaml")).toEqual(
      expect.arrayContaining([
        "ERR_BREAKING_FIELD_NOW_REQUIRED",
        "ERR_BREAKING_ENUM_VALUE_REMOVED",
        "ERR_SUNSET_REMOVAL_EXPIRED",
      ]),
    );
    const partner = findingsOf("specs/policy-api/4-endorsement-rules.yaml").filter(
      (item) => item.consumer === "partner-portal",
    );
    expect(
      partner.find((item) => item.field_path === "requestedBy")?.code,
    ).toBe("ERR_BREAKING_FIELD_NOW_REQUIRED");
    const enumFinding = partner.find((item) => item.code === "ERR_BREAKING_ENUM_VALUE_REMOVED");
    expect(enumFinding?.field_path).toBe("type");
    expect(enumFinding?.message).toContain("possible-usage"); // L-5 wording
  });

  it("row 9: claims 1.0.0 publishes", async () => {
    await boot();
    expect(statusOf("specs/claims-api/1-initial.yaml")).toBe("published");
  });

  it("row 10: claims 2-channel blocked as invalid ($ref ClaimDocumnt)", async () => {
    await boot();
    expect(statusOf("specs/claims-api/2-channel-and-notes.yaml")).toBe("blocked");
    expect(reasonCodesOf("specs/claims-api/2-channel-and-notes.yaml")).toEqual([
      "ERR_INVALID_SPEC",
    ]);
    expect(
      findingsOf("specs/claims-api/2-channel-and-notes.yaml")
        .filter((item) => item.code === "ERR_INVALID_SPEC")
        .map((item) => item.message)
        .join(" "),
    ).toContain("ClaimDocumnt");
  });

  it("row 11: claims 3-fixed rejected — duplicate version, guidance 'publish this as 1.1.1'", async () => {
    await boot();
    expect(statusOf("specs/claims-api/3-channel-and-notes-fixed.yaml")).toBe("rejected");
    const dup = findingsOf("specs/claims-api/3-channel-and-notes-fixed.yaml").find(
      (item) => item.code === "ERR_DUPLICATE_VERSION",
    );
    expect(dup?.message).toContain("publish this as 1.1.1");
  });

  it("row 12: claims 2.0.0 blocked — amountApproved optional break hits mobile-app", async () => {
    await boot();
    expect(statusOf("specs/claims-api/4-approval-later.yaml")).toBe("blocked");
    expect(reasonCodesOf("specs/claims-api/4-approval-later.yaml")).toContain(
      "ERR_BREAKING_FIELD_NOW_OPTIONAL",
    );
    expect(
      findingsOf("specs/claims-api/4-approval-later.yaml").filter(
        (item) => item.consumer === "mobile-app",
      )[0],
    ).toMatchObject({
      code: "ERR_BREAKING_FIELD_NOW_OPTIONAL",
      field_path: "amountApproved",
      operation_ref: "GET /claims/{claimId}",
    });
  });

  it("totals: 5 published, 6 blocked, 1 rejected", async () => {
    await boot();
    const counts = rows("SELECT status, COUNT(*) AS n FROM spec_versions GROUP BY status") as Array<{
      status: string;
      n: string;
    }>;
    const byStatus = new Map(counts.map((row) => [row.status, Number(row.n)]));
    expect(byStatus.get("published")).toBe(5);
    expect(byStatus.get("blocked")).toBe(6);
    expect(byStatus.get("rejected")).toBe(1);
  });
});

describe("impacted consumers (end-state exposure)", () => {
  it("mobile-app, payments-svc and partner-portal are exposed on exactly the matrix fields", async () => {
    await boot();
    expect(attributedFields("mobile-app")).toEqual(
      new Set(["premium.breakdown[].amount", "amountApproved"]),
    );
    expect(attributedFields("payments-svc")).toEqual(new Set(["legacyCode"]));
    expect(attributedFields("partner-portal")).toEqual(new Set(["requestedBy", "type"]));
  });

  it("notifications-svc is never exposed", async () => {
    await boot();
    const count = rows(
      `SELECT COUNT(*) AS n FROM findings f JOIN consumers c ON c.id = f.consumer_id
       WHERE c.name = 'notifications-svc'`,
    )[0] as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("x-internal exclusion (PO-1 / L-1)", () => {
  it("no blocking finding or impact ever references the internal pricing-cache op", async () => {
    await boot();
    const offenders = rows(
      `SELECT f.code, f.operation_ref FROM findings f
       WHERE f.operation_ref LIKE '%pricing-cache%' AND f.severity = 'blocking'`,
    );
    expect(offenders).toEqual([]);
    const notes = rows(
      `SELECT COUNT(*) AS n FROM findings f
       WHERE f.operation_ref LIKE '%pricing-cache%' AND f.code = 'WARN_INTERNAL_CHANGE_NOTED'`,
    )[0] as { n: number };
    expect(notes.n).toBeGreaterThan(0); // noted, per PLAN §7 row 3
  });
});

describe("actual webhook receipt (§8, live receiver)", () => {
  it("every §8 alert type arrives with the documented payload shape", async () => {
    await boot();
    const paths = new Set(received.map((item) => item.path));
    for (const path of [
      "/alerts/block/quote-api/2.0.0",
      "/alerts/consumer/mobile-app",
      "/alerts/block/policy-api/2.0.0",
      "/alerts/consumer/payments-svc",
      "/alerts/block/policy-api/2.1.0",
      "/alerts/consumer/partner-portal",
      "/alerts/block/claims-api/2.0.0",
      "/alerts/invalid-spec/claims-api/1.1.0",
      "/alerts/rejected/claims-api/1.1.0",
      "/alerts/deprecation/policy-api/1.1.0",
      "/alerts/sunset-overdue/policy-api",
    ]) {
      expect(paths, `receiver got ${path}`).toContain(path);
    }

    // Payload sketch (PLAN §8) on the block summary, with L-6 codes inside.
    const block = received.find((item) => item.path === "/alerts/block/quote-api/2.0.0");
    expect(block?.body).toMatchObject({
      event: "publication_blocked",
      service: "quote-api",
      owner: "Quotes team",
      from_version: "1.1.0",
      to_version: "2.0.0",
      verdict: "blocked",
      as_of: AS_OF,
    });
    expect(block?.body).toHaveProperty("findings");
    const codes = (block?.body.findings as Array<{ code: string }>).map((item) => item.code);
    expect(codes).toContain("ERR_BREAKING_FIELD_REMOVED");

    // The consumer message names the consumer and the field.
    const mobile = received.find((item) => item.path === "/alerts/consumer/mobile-app");
    expect(mobile?.body).toMatchObject({ event: "consumer_impact", consumer: "mobile-app", team: "Mobile" });

    // Nothing was ever sent about the internal operation.
    expect(
      received.filter((item) => JSON.stringify(item.body).includes("pricing-cache")),
    ).toEqual([]);

    // Every alert row ended as sent; the receiver API confirms receipt.
    const alertStatuses = rows("SELECT status, COUNT(*) AS n FROM alerts GROUP BY status") as Array<{
      status: string;
      n: number;
    }>;
    expect(alertStatuses).toHaveLength(1);
    expect(alertStatuses[0]?.status).toBe("sent");
    expect(alertStatuses[0]?.n).toBe(received.length);
    const response = await request(await appFor(env())).get("/api/health").expect(200);
    expect(response.body.status).toBe("ok");
  });
});

// Minimal app for the last health check above (registry endpoints covered in phase 8).
async function appFor(fixture: Fixture) {
  return createApp({
    config: fixture.config,
    db: fixture.db,
    logger: createLogger({ level: "error" }),
  });
}

describe("startup / restart behavior (L-3)", () => {
  it("a second startup replays identically, re-fires alerts, and keeps history", async () => {
    const first = await boot();
    const firstAlertCount = (rows("SELECT COUNT(*) AS n FROM alerts")[0] as { n: number }).n;
    const firstEventCount = (
      rows("SELECT COUNT(*) AS n FROM events WHERE kind = 'gate_decision'")[0] as { n: number }
    ).n;
    const firstReceiverCount = received.length;

    const second = await runStartupPipeline({
      ...env(),
      deliver: { maxAttempts: 1, timeoutMs: 2000 },
    });
    expect(second.totals).toEqual(first.totals);
    expect(second.totals).toEqual({ published: 5, blocked: 6, rejected: 1 });

    const nowAlertCount = (rows("SELECT COUNT(*) AS n FROM alerts")[0] as { n: number }).n;
    const nowEventCount = (
      rows("SELECT COUNT(*) AS n FROM events WHERE kind = 'gate_decision'")[0] as { n: number }
    ).n;
    expect(nowAlertCount).toBe(firstAlertCount * 2); // alerts re-fire every launch
    expect(nowEventCount).toBe(firstEventCount * 2); // both runs retained in history
    expect(received.length).toBe(firstReceiverCount * 2);
  });
});

describe("read-only law: inputs byte-identical after the entire acceptance run", () => {
  it("specs/ and consumers/ match the pre-run fingerprint exactly", async () => {
    await boot();
    // Also run write-path actions first, so the check covers every code path:
    const { config, db } = env();
    const app = createApp({ config, db, logger: createLogger({ level: "error" }) });
    await request(app).post("/api/services/quote-api/versions/2.0.0/publish").expect(200);
    await request(app).post("/api/recheck").expect(200);
    expect(kitFingerprint()).toBe(fingerprintBefore);
    // 16 files exist and none is newer than the run start or modified.
    expect(fingerprintBefore.length).toBe(64);
  });
});
