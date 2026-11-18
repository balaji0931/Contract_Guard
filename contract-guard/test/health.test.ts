import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { createLogger } from "../src/logger.js";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

const silentLogger = createLogger({ level: "error" });

function build(overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cg-health-"));
  dirs.push(dir);
  const config = loadConfig({ CG_DB_PATH: join(dir, "cg.db"), ...overrides }, dir);
  const { db, applied } = openDatabase({ path: config.dbPath });
  handles.push(db);
  return { app: createApp({ config, db, logger: silentLogger }), config, applied };
}

afterEach(() => {
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("returns 200 with the running configuration once migrations are applied", async () => {
    const { app, applied } = build({ CG_AS_OF_DATE: "2026-11-18", GATE_MODE: "strict" });
    expect(applied).toEqual(["0001_baseline_registry_schema"]);

    const response = await request(app).get("/api/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      service: "contract-guard",
      gateMode: "strict",
      asOfDate: "2026-11-18",
      asOfDatePinned: true,
      fresh: true,
      webhookUrl: "http://localhost:9900",
      db: { ok: true, migrations: ["0001_baseline_registry_schema"], pending: [] },
    });
    expect(typeof response.body.version).toBe("string");
    expect(typeof response.body.uptimeSeconds).toBe("number");
  });

  it("reports the unpinned as-of date when CG_AS_OF_DATE is absent", async () => {
    const { app, config } = build();
    const response = await request(app).get("/api/health").expect(200);
    expect(response.body.asOfDate).toBe(config.asOfDate.toISOString().slice(0, 10));
    expect(response.body.asOfDatePinned).toBe(false);
  });

  it("degrades to 503 while migrations are pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-health-pending-"));
    dirs.push(dir);
    const config = loadConfig({ CG_DB_PATH: join(dir, "cg.db") }, dir);
    // Open without installing the baseline, so it stays pending.
    const { db, applied } = openDatabase({ path: config.dbPath, migrations: [] });
    handles.push(db);
    expect(applied).toEqual([]);

    const response = await request(createApp({ config, db, logger: silentLogger }))
      .get("/api/health")
      .expect(503);

    expect(response.body.status).toBe("degraded");
    expect(response.body.db.ok).toBe(false);
    expect(response.body.db.pending).toEqual(["0001_baseline_registry_schema"]);
  });

  it("serves JSON errors for unknown routes", async () => {
    const { app } = build();
    const response = await request(app).get("/api/nope").expect(404);
    expect(response.body).toEqual({ error: "not_found" });
  });
});
