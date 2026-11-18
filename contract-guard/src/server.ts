/**
 * Process entry point: configuration, database, startup pipeline, HTTP server.
 */
import { createApp, APP_NAME, APP_VERSION } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { createLogger } from "./logger.js";
import { runStartupPipeline } from "./pipeline/startup.js";

function main(): void {
  const logger = createLogger({ level: process.env.CG_LOG_LEVEL });

  let config;
  try {
    config = loadConfig(process.env, process.cwd());
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("startup aborted", { problems: error.problems.join(" | ") });
      process.exit(1);
    }
    throw error;
  }

  const { db, applied } = openDatabase({ path: config.dbPath });
  if (applied.length) logger.info("migrations applied", { ids: applied.join(",") });

  const app = createApp({ config, db, logger });
  const server = app.listen(config.port, () => {
    logger.info(`${APP_NAME} ${APP_VERSION} listening`, {
      port: config.port,
      gateMode: config.gateMode,
      asOfDate: config.asOfDate.toISOString().slice(0, 10),
      asOfDatePinned: config.asOfDatePinned,
      fresh: config.fresh,
      dbPath: config.dbPath,
      webhookUrl: config.webhookUrl,
    });
  });

  // Startup pipeline (L-3): scan, publish in file order, alert, sunset checks.
  // Runs after the listener is up; failures are logged, never fatal, and
  // never change gate verdicts already persisted.
  void runStartupPipeline({ db, config, logger }).catch((error: unknown) => {
    logger.error("startup pipeline failed", { error: (error as Error).message });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
