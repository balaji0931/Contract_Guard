import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { loadConfig, type Config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { openDatabase, type Database } from "../src/db/database.js";
import { createLogger } from "../src/logger.js";
import { RegistryState } from "../src/api/state.js";
import { runStartupPipeline } from "../src/pipeline/startup.js";
import type { Express } from "express";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const dirs: string[] = [];
const handles: Array<Database> = [];

let receiver: Server | undefined;
let receiverUrl = "";

beforeAll(async () => {
  receiver = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

interface Fixture {
  app: Express;
  db: Database;
  config: Config;
  state: RegistryState;
}

async function booted(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "cg-api-"));
  dirs.push(dir);
  const config = loadConfig(
    {
      PORT: "5000",
      WEBHOOK_URL: receiverUrl,
      CG_DB_PATH: join(dir, "cg.db"),
      CG_AS_OF_DATE: "2026-11-18",
      GATE_MODE: "consumer",
      CG_FRESH: "1",
      KIT_ROOT,
    },
    KIT_ROOT,
  );
  const { db } = openDatabase({ path: config.dbPath });
  handles.push(db);
  const state = new RegistryState();
  const app = createApp({ config, db, logger: createLogger({ level: "error" }), state });
  await runStartupPipeline({ db, config, deliver: { maxAttempts: 1, timeoutMs: 1000 } });
  return { app, db, config, state };
}

describe("registry read endpoints", () => {
  it("GET /api/services lists services with latest published and status counts", async () => {
    const { app } = await booted();
    const response = await request(app).get("/api/services").expect(200);
    expect(response.body).toHaveLength(3);
    const quote = response.body.find((service: { name: string }) => service.name === "quote-api");
    expect(quote).toMatchObject({ latestPublished: "1.1.0", owner: "Quotes team" });
    expect(quote.versions).toEqual(expect.arrayContaining(["published=2", "blocked=2"]));
  });

  it("GET /api/services/:name/versions returns statuses and reason codes", async () => {
    const { app } = await booted();
    const ok = await request(app).get("/api/services/policy-api/versions").expect(200);
    expect(ok.body.map((row: { status: string }) => row.status)).toEqual([
      "published",
      "published",
      "blocked",
      "blocked",
    ]);

    const missing = await request(app).get("/api/services/nope-api/versions").expect(404);
    expect(missing.body.error).toBe("not_found");
  });

  it("GET /api/services/:name/versions/:v returns every intake attempt", async () => {
    const { app } = await booted();
    const response = await request(app).get("/api/services/claims-api/versions/1.1.0").expect(200);
    expect(response.body).toMatchObject({ service: "claims-api", version: "1.1.0" });
    expect(response.body.attempts.map((a: { status: string }) => a.status)).toEqual([
      "blocked",
      "rejected",
    ]);
    const invalid = response.body.attempts.find((a: { status: string }) => a.status === "blocked");
    expect(invalid.findings.some((f: { code: string }) => f.code === "ERR_INVALID_SPEC")).toBe(true);

    await request(app).get("/api/services/claims-api/versions/9.9.9").expect(404);
  });

  it("GET /api/services/:name/versions/:v/impact exposes per-consumer attribution", async () => {
    const { app } = await booted();
    const response = await request(app)
      .get("/api/services/quote-api/versions/2.0.0/impact")
      .expect(200);
    expect(response.body.statuses).toContain("blocked");
    expect(response.body.reasonCodes).toContain("ERR_BREAKING_FIELD_REMOVED");
    expect(response.body.impactedConsumers).toHaveLength(1);
    expect(response.body.impactedConsumers[0]).toMatchObject({
      consumer: "mobile-app",
      team: "Mobile",
    });
    expect(response.body.impactedConsumers[0].issues[0]).toMatchObject({
      code: "ERR_BREAKING_FIELD_REMOVED",
      field_path: "premium.breakdown[].amount",
    });

    await request(app).get("/api/services/quote-api/versions/9.9.9/impact").expect(404);
  });

  it("GET /api/consumers lists all four consumers with usage and issue counts", async () => {
    const { app } = await booted();
    const response = await request(app).get("/api/consumers").expect(200);
    expect(response.body.map((c: { name: string }) => c.name)).toEqual([
      "mobile-app",
      "notifications-svc",
      "partner-portal",
      "payments-svc",
    ]);
    const byName = new Map(
      response.body.map((c: { name: string; openIssues: number }) => [c.name, c.openIssues]),
    );
    expect(byName.get("notifications-svc")).toBe(0);
    expect((byName.get("mobile-app") as number) ?? 0).toBeGreaterThan(0);
    expect(response.body[0].uses.length).toBeGreaterThan(0);
  });

  it("GET /api/consumers/:name/risks reports exposure; unknown consumers 404", async () => {
    const { app } = await booted();
    const clean = await request(app).get("/api/consumers/notifications-svc/risks").expect(200);
    expect(clean.body).toMatchObject({ consumer: "notifications-svc", exposed: false });
    expect(clean.body.issues).toEqual([]);

    const risky = await request(app).get("/api/consumers/payments-svc/risks").expect(200);
    expect(risky.body.exposed).toBe(true);
    expect(
      risky.body.issues.some((issue: { code: string }) =>
        ["ERR_SUNSET_REMOVAL_EXPIRED", "WARN_SUNSET_OVERDUE"].includes(issue.code),
      ),
    ).toBe(true);

    await request(app).get("/api/consumers/ghost-svc/risks").expect(404);
  });

  it("GET /api/findings filters by service, code and consumer", async () => {
    const { app } = await booted();
    const all = await request(app).get("/api/findings").expect(200);
    expect(all.body.length).toBeGreaterThan(0);

    const sunset = await request(app)
      .get("/api/findings")
      .query({ code: "WARN_SUNSET_OVERDUE" })
      .expect(200);
    expect(sunset.body.every((f: { code: string }) => f.code === "WARN_SUNSET_OVERDUE")).toBe(true);
    expect(sunset.body.length).toBeGreaterThan(0);

    const payments = await request(app)
      .get("/api/findings")
      .query({ consumer: "payments-svc", service: "policy-api" })
      .expect(200);
    expect(
      payments.body.every(
        (f: { consumer: string; service: string }) =>
          f.consumer === "payments-svc" && f.service === "policy-api",
      ),
    ).toBe(true);
  });

  it("GET /api/alerts and GET /api/events return newest-first audit data", async () => {
    const { app } = await booted();
    const alerts = await request(app).get("/api/alerts").expect(200);
    expect(alerts.body.length).toBeGreaterThan(0);
    expect(alerts.body[0]).toMatchObject({ status: "sent" });
    const ids = alerts.body.map((a: { id: number }) => a.id);
    expect([...ids].sort((left, right) => right - left)).toEqual(ids);

    const gateEvents = await request(app).get("/api/events").query({ kind: "gate_decision" }).expect(200);
    expect(gateEvents.body).toHaveLength(12);
    expect(gateEvents.body[0].outcome).toBeDefined();
  });
});

describe("publish endpoint re-runs the gate and cannot bypass rules", () => {
  it("publishing a blocked candidate blocks it again (same reasons)", async () => {
    const { app, db } = await booted();
    const response = await request(app)
      .post("/api/services/quote-api/versions/2.0.0/publish")
      .expect(200);
    expect(response.body).toMatchObject({
      outcome: "blocked",
      baselineVersion: "1.1.0",
    });
    expect(response.body.reasonCodes).toContain("ERR_BREAKING_FIELD_REMOVED");
    expect(response.body.impactedConsumers).toEqual(["mobile-app"]);

    const status = db
      .prepare(
        `SELECT sv.status FROM spec_versions sv JOIN services s ON s.id = sv.service_id
         WHERE s.name = 'quote-api' AND sv.version = '2.0.0'`,
      )
      .get() as { status: string };
    expect(status.status).toBe("blocked");
  });

  it("publishing a rejected duplicate stays rejected with next-number guidance", async () => {
    const { app } = await booted();
    const response = await request(app)
      .post("/api/services/claims-api/versions/1.1.0/publish")
      .expect(200);
    expect(response.body.outcome).toBe("rejected");
    expect(response.body.reasonCodes).toEqual(["ERR_DUPLICATE_VERSION"]);
  });

  it("publishing an already published version keeps it published (idempotent)", async () => {
    const { app, db } = await booted();
    const response = await request(app)
      .post("/api/services/quote-api/versions/1.1.0/publish")
      .expect(200);
    expect(response.body.outcome).toBe("published");
    const events = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE kind = 'gate_decision'
         AND service = 'quote-api' AND version = '1.1.0'`,
      )
      .get() as { n: number };
    expect(events.n).toBe(2); // startup run + this explicit publish
  });

  it("unknown service or version returns 404", async () => {
    const { app } = await booted();
    await request(app).post("/api/services/ghost-api/versions/1.0.0/publish").expect(404);
    await request(app).post("/api/services/quote-api/versions/9.9.9/publish").expect(404);
  });
});

describe("POST /api/specs — manual uploads run the same pipeline", () => {
  it("publishes a benign new version of a clean service", async () => {
    const { app, db } = await booted();
    const yaml = `openapi: 3.0.0
info:
  title: Notes API
  version: 1.0.0
  description: 'Notes. Owner: Notes team.'
paths:
  /notes:
    get:
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
`;
    const response = await request(app).post("/api/specs").send({ service: "notes-api", yaml }).expect(201);
    expect(response.body).toMatchObject({
      service: "notes-api",
      version: "1.0.0",
      valid: true,
      outcome: "published",
    });
    const versions = await request(app).get("/api/services/notes-api/versions").expect(200);
    expect(versions.body).toHaveLength(1);
    expect(versions.body[0].source_file).toBe("api-upload/notes-api/1.0.0.yaml");
    expect(db.prepare("SELECT COUNT(*) AS n FROM operations").get()).toBeDefined();
  });

  it("dedupes a reserved version number exactly like the kit intake (L-2)", async () => {
    const { app } = await booted();
    const yaml = `openapi: 3.0.0
info:
  title: Quote API v2 clone
  version: 2.0.0
  description: 'Quotes. Owner: Quotes team.'
paths: {}
`;
    const response = await request(app).post("/api/specs").send({ service: "quote-api", yaml }).expect(201);
    // 2.0.0 is already reserved by the blocked kit file → rejected, not published.
    expect(response.body).toMatchObject({ outcome: "rejected", version: "2.0.0" });
    expect(response.body.reasonCodes).toEqual(["ERR_DUPLICATE_VERSION"]);
  });

  it("blocks an upload that breaks a known consumer", async () => {
    const { app } = await booted();
    // Copy the shape of quote 1.1.0's POST /quotes response minus `amount`.
    const yaml = `openapi: 3.0.0
info:
  title: Quote API
  version: 3.0.0
  description: 'Bike insurance quotes. Owner: Quotes team.'
paths:
  /quotes:
    post:
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                properties:
                  quoteId: { type: string }
                  premium:
                    type: object
                    properties:
                      total: { type: number }
                      breakdown:
                        type: array
                        items:
                          type: object
                          properties:
                            label: { type: string }
                            value: { type: number }
`;
    const response = await request(app).post("/api/specs").send({ service: "quote-api", yaml }).expect(201);
    expect(response.body.outcome).toBe("blocked");
    expect(response.body.impactedConsumers).toContain("mobile-app");
  });

  it("rejects malformed requests and unparseable specs with 400", async () => {
    const { app } = await booted();
    await request(app).post("/api/specs").send({ yaml: "info: {}" }).expect(400);
    await request(app).post("/api/specs").send({ service: "ok-api", yaml: "\t: [" }).expect(400);
    await request(app)
      .post("/api/specs")
      .send({ service: "ok-api", yaml: "openapi: 3.0.0\ninfo: { title: x }\npaths: {}\n" })
      .expect(400); // no info.version
  });
});

describe("POST /api/recheck runs the sunset engine and retries alerts", () => {
  it("flags the overdue legacyCode sunset and clears failed alerts", async () => {
    const { app, db } = await booted();
    // Create a failed alert row against a dead receiver.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    const deadPort = typeof address === "object" && address !== null ? address.port : 1;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    db.prepare(
      "INSERT INTO alerts (webhook_path, payload, status, attempts) VALUES (?, ?, 'failed', 1)",
    ).run("/alerts/block/quote-api/2.0.0", JSON.stringify({ event: "publication_blocked" }));

    const response = await request(app).post("/api/recheck").expect(200);
    expect(response.body.asOf).toBe("2026-11-18");
    const hit = response.body.sunsetOverdue.find(
      (item: { fieldPath: string }) => item.fieldPath === "legacyCode",
    );
    expect(hit).toMatchObject({
      service: "policy-api",
      version: "1.1.0",
      sunsetDate: "2026-11-01",
      overdue: true,
      consumers: ["payments-svc"],
    });
    // The retried alert now succeeded against the live receiver.
    expect(response.body.retriedAlerts).toMatchObject({ retried: 1, sent: 1, failed: 0 });
    void deadPort;
  });
});

describe("dashboard", () => {
  it("GET / renders versions, findings, risks and alerts with re-publish buttons", async () => {
    const { app } = await booted();
    const response = await request(app).get("/").expect(200);
    expect(response.headers["content-type"]).toMatch(/html/);
    const html: string = response.text;
    // Version timeline with statuses for all three services.
    for (const service of ["quote-api", "policy-api", "claims-api"]) {
      expect(html).toContain(service);
    }
    expect(html).toContain("published");
    expect(html).toContain("blocked");
    expect(html).toContain("rejected");
    // Findings + consumer risk list + alert log + actions.
    expect(html).toContain("ERR_BREAKING_FIELD_REMOVED");
    expect(html).toContain("mobile-app");
    expect(html).toContain("/alerts/block/quote-api/2.0.0");
    expect(html).toContain("re-publish");
    expect(html).toContain("/api/services/");
  });
});
