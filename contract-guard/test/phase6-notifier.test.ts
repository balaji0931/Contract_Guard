import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db/database.js";
import { indexKit, type KitIndexResult } from "../src/pipeline/indexKit.js";
import {
  candidatesForGate,
  runPublicationGate,
  type GateCandidate,
} from "../src/gate/publicationGate.js";
import {
  alertPaths,
  deliverAlert,
  dispatchPublicationAlerts,
  dispatchSunsetOverdueAlert,
  retryFailedAlerts,
} from "../src/notify/notifier.js";
import { finding } from "../src/findings/codes.js";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const AS_OF = new Date(Date.UTC(2026, 10, 18));
/** Retries stay fast in tests; production keeps the notifier defaults. */
const TEST_DELIVERY = { maxAttempts: 2, baseDelayMs: 5, timeoutMs: 1000 };

const dirs: string[] = [];
const handles: Array<Database> = [];

interface Received {
  path: string;
  body: Record<string, unknown>;
}

let receiver: Server | undefined;
let receiverUrl = "";
let received: Received[] = [];
const openPorts: number[] = [];

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
      response.end(JSON.stringify({ ok: true, id: received.length }));
    });
  });
  await new Promise<void>((resolve) => receiver?.listen(0, "127.0.0.1", resolve));
  const address = receiver?.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  openPorts.push(port);
  receiverUrl = `http://127.0.0.1:${port}`;
  return receiverUrl;
}

async function stoppedUrl(): Promise<string> {
  // Bind and close a port so connection-refused is deterministic.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 1;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
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

function alertRows(db: Database) {
  return db
    .prepare("SELECT id, webhook_path, payload, status, attempts, http_status, last_error, sent_at FROM alerts ORDER BY id")
    .all() as Array<{
    id: number;
    webhook_path: string;
    payload: string;
    status: string;
    attempts: number;
    http_status: number | null;
    last_error: string | null;
    sent_at: string | null;
  }>;
}

interface Fixture {
  db: Database;
  index: KitIndexResult;
  candidates: GateCandidate[];
}

function newFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "cg-notify-"));
  dirs.push(dir);
  const { db } = openDatabase({ path: join(dir, "cg.db") });
  handles.push(db);
  const index = indexKit(KIT_ROOT, db);
  return { db, index, candidates: candidatesForGate(index.specs, index.load.specs) };
}

/** Publish a service's files in filename order; returns verdicts per order. */
function runService(fixture: Fixture, service: string) {
  const versions = fixture.candidates
    .filter((candidate) => candidate.service === service)
    .sort((left, right) => left.order - right.order);
  const byOrder = new Map<number, ReturnType<typeof runPublicationGate>>();
  for (const candidate of versions) {
    byOrder.set(
      candidate.order,
      runPublicationGate(fixture.db, candidate, {
        mode: "consumer",
        asOfDate: AS_OF,
        consumerIndex: fixture.index.consumers,
        serviceVersions: versions,
      }),
    );
  }
  return { versions, byOrder };
}

function candidateAt(fixture: Fixture, service: string, order: number): GateCandidate {
  return (
    fixture.candidates.find((candidate) => candidate.service === service && candidate.order === order) ??
    (undefined as never)
  );
}

function ownerOf(fixture: Fixture, service: string, order: number): string | null {
  const candidate = candidateAt(fixture, service, order);
  const row = fixture.db
    .prepare(
      `SELECT sv.owner FROM spec_versions sv JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? AND sv.source_file = ?`,
    )
    .get(service, candidate.sourceFile) as { owner: string | null };
  return row.owner;
}

async function dispatchAll(fixture: Fixture, service: string) {
  const { byOrder } = runService(fixture, service);
  for (const candidate of fixture.candidates
    .filter((item) => item.service === service)
    .sort((left, right) => left.order - right.order)) {
    const verdict = byOrder.get(candidate.order);
    if (verdict === undefined) continue;
    await dispatchPublicationAlerts(fixture.db, receiverUrl, {
      service: candidate.service,
      version: candidate.version,
      owner: ownerOf(fixture, service, candidate.order),
      specFile: candidate.sourceFile,
      baselineVersion: verdict.baselineVersion,
      verdict,
      intakeFindings: candidate.intakeFindings,
      asOfDate: AS_OF,
    }, TEST_DELIVERY);
  }
}

describe("blocked publication alerts (PLAN §8 rows 1–2)", () => {
  it("quote 2.0.0 sends a block summary and one mobile-app message with §8 payloads", async () => {
    const fixture = newFixture();
    await dispatchAll(fixture, "quote-api");

    const block = received.find((item) => item.path === "/alerts/block/quote-api/2.0.0");
    expect(block, "block summary received").toBeDefined();
    const summary = block?.body as Record<string, unknown>;
    // §8 payload sketch: every key present.
    for (const key of [
      "event",
      "service",
      "owner",
      "from_version",
      "to_version",
      "action",
      "verdict",
      "findings",
      "spec_file",
      "as_of",
      "occurred_at",
    ]) {
      expect(summary, `payload key ${key}`).toHaveProperty(key);
    }
    expect(summary).toMatchObject({
      event: "publication_blocked",
      service: "quote-api",
      owner: "Quotes team",
      from_version: "1.1.0",
      to_version: "2.0.0",
      verdict: "blocked",
      spec_file: "specs/quote-api/3-price-lines.yaml",
      as_of: "2026-11-18",
    });
    // L-6 codes ride in the findings list.
    const codes = (summary.findings as Array<{ code: string }>).map((item) => item.code);
    expect(codes).toContain("ERR_BREAKING_FIELD_REMOVED");

    const consumer = received.find((item) => item.path === "/alerts/consumer/mobile-app");
    expect(consumer, "mobile-app alert received").toBeDefined();
    expect(consumer?.body).toMatchObject({
      event: "consumer_impact",
      consumer: "mobile-app",
      team: "Mobile",
      service: "quote-api",
      verdict: "blocked",
    });
    const impact = (consumer?.body.findings as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(impact).toMatchObject({
      code: "ERR_BREAKING_FIELD_REMOVED",
      field_path: "premium.breakdown[].amount",
    });
    expect(String(impact.message)).toContain("mobile-app");

    // Consumers with no impact get no message.
    expect(received.some((item) => item.path === "/alerts/consumer/notifications-svc")).toBe(false);

    const rows = alertRows(fixture.db).filter((row) => row.status === "sent");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.attempts >= 1 && row.sent_at !== null)).toBe(true);
  });
});

describe("invalid-spec and rejected alerts (§8 rows 5–6)", () => {
  it("claims-api produces invalid-spec, block, and rejected alerts", async () => {
    const fixture = newFixture();
    await dispatchAll(fixture, "claims-api");

    const invalid = received.find((item) => item.path === "/alerts/invalid-spec/claims-api/1.1.0");
    expect(invalid).toBeDefined();
    const invalidCodes = ((invalid?.body as Record<string, unknown>).findings as Array<{
      code: string;
      message: string;
    }>).map((item) => item.code);
    expect(invalidCodes).toContain("ERR_INVALID_SPEC");

    const rejected = received.find((item) => item.path === "/alerts/rejected/claims-api/1.1.0");
    expect(rejected).toBeDefined();
    expect(rejected?.body).toMatchObject({ event: "version_rejected", verdict: "rejected" });
    const rejectedFindings = (rejected?.body as Record<string, unknown>).findings as Array<{
      code: string;
      message: string;
    }>;
    expect(rejectedFindings[0]?.code).toBe("ERR_DUPLICATE_VERSION");
    expect(rejectedFindings[0]?.message).toMatch(/publish this as 1\.1\.1/);

    // Claims 2.0.0 blocked on mobile impact → summary + mobile message.
    expect(received.some((item) => item.path === "/alerts/block/claims-api/2.0.0")).toBe(true);
    expect(received.some((item) => item.path === "/alerts/consumer/mobile-app")).toBe(true);
  });
});

describe("deprecation alert on a published version (§8 row 3)", () => {
  it("policy 1.1.0 publishes with a deprecation notice carrying sunset dates", async () => {
    const fixture = newFixture();
    await dispatchAll(fixture, "policy-api");

    const deprecation = received.find(
      (item) => item.path === "/alerts/deprecation/policy-api/1.1.0",
    );
    expect(deprecation, "deprecation alert received").toBeDefined();
    expect(deprecation?.body).toMatchObject({
      event: "field_deprecated",
      service: "policy-api",
      owner: "Policy team",
      verdict: "published",
    });
    const findings = (deprecation?.body as Record<string, unknown>).findings as Array<{
      code: string;
      message: string;
    }>;
    expect(new Set(findings.map((item) => item.code))).toEqual(new Set(["WARN_DEPRECATED_FIELD"]));
    const messages = findings.map((item) => item.message).join(" ");
    expect(messages).toMatch(/2026-11-01/);
    expect(messages).toMatch(/2027-06-30/);
  });
});

describe("sunset-overdue alert (§8 row 4)", () => {
  it("dispatches to /alerts/sunset-overdue/{service}", async () => {
    const fixture = newFixture();
    const record = await dispatchSunsetOverdueAlert(
      fixture.db,
      receiverUrl,
      {
        service: "policy-api",
        owner: "Policy team",
        specFile: "specs/policy-api/2-deprecations.yaml",
        version: "1.1.0",
        findings: [
          finding("WARN_SUNSET_OVERDUE", "field `legacyCode` sunset 2026-11-01 passed and is still read", {
            operationRef: "GET /policies/{policyId}",
            fieldPath: "legacyCode",
          }),
        ],
        asOfDate: AS_OF,
      },
      TEST_DELIVERY,
    );
    expect(record.status).toBe("sent");
    expect(received[0]?.path).toBe("/alerts/sunset-overdue/policy-api");
    expect(received[0]?.body).toMatchObject({ event: "sunset_overdue", as_of: "2026-11-18" });
  });
});

describe("failure and retry are recorded; gate outcomes never change (§8 durability)", () => {
  it("an unavailable receiver fails every attempt, records it, and leaves the verdict blocked", async () => {
    const fixture = newFixture();
    const dead = await stoppedUrl();

    // Block quote 2.0.0 with the gate, then fail all deliveries.
    const { byOrder } = runService(fixture, "quote-api");
    const candidate = candidateAt(fixture, "quote-api", 3);
    const verdict = byOrder.get(3);
    expect(verdict?.outcome).toBe("blocked");

    const records = await dispatchPublicationAlerts(
      fixture.db,
      dead,
      {
        service: "quote-api",
        version: candidate.version,
        owner: ownerOf(fixture, "quote-api", 3),
        specFile: candidate.sourceFile,
        baselineVersion: "1.1.0",
        verdict: verdict as never,
        intakeFindings: [],
        asOfDate: AS_OF,
      },
      TEST_DELIVERY,
    );
    expect(records.length).toBeGreaterThanOrEqual(2); // summary + consumer message
    expect(records.every((record) => record.status === "failed")).toBe(true);
    expect(records.every((record) => record.attempts === TEST_DELIVERY.maxAttempts)).toBe(true);
    expect(records.every((record) => record.last_error !== null)).toBe(true);

    // The blocked verdict survived untouched.
    const status = fixture.db
      .prepare(
        `SELECT sv.status FROM spec_versions sv JOIN services s ON s.id = sv.service_id
         WHERE s.name = 'quote-api' AND sv.source_file = ?`,
      )
      .get(candidate.sourceFile) as { status: string };
    expect(status.status).toBe("blocked");
  });

  it("retryFailedAlerts resends once the receiver is back, incrementing attempts", async () => {
    const fixture = newFixture();
    const dead = await stoppedUrl();
    const first = await deliverAlert(
      fixture.db,
      dead,
      "/alerts/block/demo-api/1.0.0",
      {
        event: "publication_blocked",
        service: "demo-api",
        owner: null,
        from_version: null,
        to_version: "1.0.0",
        action: "block",
        verdict: "blocked",
        findings: [],
        spec_file: null,
        as_of: "2026-11-18",
        occurred_at: new Date().toISOString(),
      },
      TEST_DELIVERY,
    );
    expect(first.status).toBe("failed");
    expect(first.attempts).toBe(2);

    // Receiver comes back.
    await startReceiver();
    const result = await retryFailedAlerts(fixture.db, receiverUrl, TEST_DELIVERY);
    expect(result).toEqual({ retried: 1, sent: 1, failed: 0 });

    const row = alertRows(fixture.db)[0];
    expect(row).toMatchObject({ status: "sent", attempts: 3 });
    expect(row?.sent_at).toBeTruthy();
    expect(received[0]?.path).toBe("/alerts/block/demo-api/1.0.0");
  });

  it("a throwing receiver records the HTTP failure without crashing delivery", async () => {
    const fixture = newFixture();
    const broken = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const address = broken.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    const record = await deliverAlert(
      fixture.db,
      url,
      "/alerts/block/demo-api/2.0.0",
      {
        event: "publication_blocked",
        service: "demo-api",
        owner: null,
        from_version: null,
        to_version: "2.0.0",
        action: "block",
        verdict: "blocked",
        findings: [],
        spec_file: null,
        as_of: "2026-11-18",
        occurred_at: new Date().toISOString(),
      },
      TEST_DELIVERY,
    );
    await new Promise<void>((resolve) => broken.close(() => resolve()));
    expect(record.status).toBe("failed");
    expect(record.http_status).toBe(500);
    expect(record.last_error).toMatch(/HTTP 500/);
  });
});

describe("path helpers match PLAN §8 exactly", () => {
  it("builds all six documented paths", () => {
    expect(alertPaths.block("quote-api", "2.0.0")).toBe("/alerts/block/quote-api/2.0.0");
    expect(alertPaths.consumer("mobile-app")).toBe("/alerts/consumer/mobile-app");
    expect(alertPaths.deprecation("policy-api", "1.1.0")).toBe("/alerts/deprecation/policy-api/1.1.0");
    expect(alertPaths.sunsetOverdue("policy-api")).toBe("/alerts/sunset-overdue/policy-api");
    expect(alertPaths.invalidSpec("claims-api", "1.1.0")).toBe("/alerts/invalid-spec/claims-api/1.1.0");
    expect(alertPaths.rejected("claims-api", "1.1.0")).toBe("/alerts/rejected/claims-api/1.1.0");
  });
});
