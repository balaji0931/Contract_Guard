/**
 * Express application factory. Kept free of `listen` and process wiring so the
 * same app can be driven by supertest in tests and by server.ts in production.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import type { Config } from "./config.js";
import type { Database } from "./db/database.js";
import { migrationStatus } from "./db/database.js";
import type { Logger } from "./logger.js";
import { registerApi } from "./api/routes.js";
import { renderDashboard } from "./api/dashboard.js";
import { RegistryState } from "./api/state.js";

export const APP_NAME = "contract-guard";
export const APP_VERSION = "0.1.0";

export interface AppDependencies {
  config: Config;
  db: Database;
  logger: Logger;
  /** When the process started — reported by /api/health. */
  startedAt?: Date;
  /** Shared API read model (uploads + fresh per-request views). */
  state?: RegistryState;
}

export function createApp({
  config,
  db,
  logger,
  startedAt = new Date(),
  state = new RegistryState(),
}: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  app.get("/api/health", (_req: Request, res: Response) => {
    let dbHealth: { ok: boolean; migrations: string[]; pending: string[]; error?: string };
    try {
      const { applied, pending } = migrationStatus(db);
      dbHealth = { ok: pending.length === 0, migrations: applied, pending };
    } catch (error) {
      dbHealth = { ok: false, migrations: [], pending: [], error: (error as Error).message };
    }

    const healthy = dbHealth.ok;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      service: APP_NAME,
      version: APP_VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      gateMode: config.gateMode,
      asOfDate: config.asOfDate.toISOString().slice(0, 10),
      asOfDatePinned: config.asOfDatePinned,
      fresh: config.fresh,
      webhookUrl: config.webhookUrl,
      db: dbHealth,
    });
  });

  // Registry API + dashboard (PLAN.md §9); the 404 fallback must stay below.
  registerApi(app, { config, db, logger, state });
  app.get("/", (_req: Request, res: Response) => {
    res.type("html").send(renderDashboard(db));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("unhandled request error", { message: error.message });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
