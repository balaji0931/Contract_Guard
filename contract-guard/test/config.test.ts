import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, istCalendarDate, loadConfig } from "../src/config.js";

/** Minimal environment that always passes validation. */
function baseEnv(): NodeJS.ProcessEnv {
  return { CG_DB_PATH: ":memory:" };
}

describe("loadConfig defaults", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    env = baseEnv();
  });

  it("uses the locked defaults from PLAN.md §4", () => {
    const config = loadConfig(env, "/app");
    expect(config.port).toBe(5000);
    expect(config.webhookUrl).toBe("http://localhost:9900");
    expect(config.gateMode).toBe("consumer");
    expect(config.fresh).toBe(true);
    expect(config.dbPath).toBe(":memory:");
    expect(config.appRoot).toBe("/app");
  });

  it("falls back to data/contract-guard.db under the app root", () => {
    const config = loadConfig({}, "/srv/app");
    expect(config.dbPath).toBe("/srv/app/data/contract-guard.db");
  });

  it("resolves the kit root to the parent of the app by default", () => {
    expect(loadConfig({}, "/srv/app").kitRoot).toBe("/srv/app/..");
    expect(loadConfig({ KIT_ROOT: "/kit" }, "/srv/app").kitRoot).toBe("/kit");
  });

  it("defaults the as-of date to today's IST calendar date, unpinned", () => {
    const config = loadConfig(env, "/app");
    expect(config.asOfDatePinned).toBe(false);
    expect(config.asOfDate).toEqual(istCalendarDate(new Date()));
  });
});

describe("loadConfig overrides", () => {
  it("reads every supported variable", () => {
    const config = loadConfig(
      {
        PORT: "4321",
        WEBHOOK_URL: "http://receiver:9000/",
        CG_DB_PATH: "/tmp/cg.db",
        CG_AS_OF_DATE: "2026-11-18",
        GATE_MODE: "strict",
        CG_FRESH: "0",
        KIT_ROOT: "/kit",
      },
      "/app",
    );
    expect(config.port).toBe(4321);
    expect(config.webhookUrl).toBe("http://receiver:9000");
    expect(config.dbPath).toBe("/tmp/cg.db");
    expect(config.asOfDate.toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(config.asOfDatePinned).toBe(true);
    expect(config.gateMode).toBe("strict");
    expect(config.fresh).toBe(false);
  });

  it("accepts boolean spellings for CG_FRESH", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on"]) {
      expect(loadConfig({ ...baseEnv(), CG_FRESH: raw }, "/app").fresh).toBe(true);
    }
    for (const raw of ["0", "false", "FALSE", "no", "off"]) {
      expect(loadConfig({ ...baseEnv(), CG_FRESH: raw }, "/app").fresh).toBe(false);
    }
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({ PORT: "", GATE_MODE: "", CG_FRESH: "", WEBHOOK_URL: "  " }, "/app");
    expect(config.port).toBe(5000);
    expect(config.gateMode).toBe("consumer");
    expect(config.fresh).toBe(true);
    expect(config.webhookUrl).toBe("http://localhost:9900");
  });
});

describe("loadConfig rejects invalid input clearly", () => {
  it("names the offending variable for each bad value", () => {
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
      [{ PORT: "abc" }, /PORT must be an integer between 1 and 65535, got "abc"/],
      [{ PORT: "0" }, /PORT/],
      [{ PORT: "70000" }, /PORT/],
      [{ PORT: "1.5" }, /PORT/],
      [{ WEBHOOK_URL: "not-a-url" }, /WEBHOOK_URL must be an absolute http\(s\) URL, got "not-a-url"/],
      [{ WEBHOOK_URL: "ftp://host:21" }, /WEBHOOK_URL must use http or https/],
      [{ CG_AS_OF_DATE: "18-11-2026" }, /CG_AS_OF_DATE must be YYYY-MM-DD, got "18-11-2026"/],
      [{ CG_AS_OF_DATE: "2026-02-31" }, /CG_AS_OF_DATE must be a real calendar date/],
      [{ CG_AS_OF_DATE: "2026-13-01" }, /CG_AS_OF_DATE must be a real calendar date/],
      [{ GATE_MODE: "yolo" }, /GATE_MODE must be one of consumer, strict, got "yolo"/],
      [{ CG_FRESH: "maybe" }, /CG_FRESH must be a boolean \(1\/0, true\/false\), got "maybe"/],
    ];

    for (const [overrides, pattern] of cases) {
      expect(() => loadConfig({ ...baseEnv(), ...overrides }, "/app")).toThrow(ConfigError);
      try {
        loadConfig({ ...baseEnv(), ...overrides }, "/app");
      } catch (error) {
        expect((error as Error).message).toMatch(pattern);
      }
    }
  });

  it("reports every problem at once instead of failing one at a time", () => {
    let caught: ConfigError | undefined;
    try {
      loadConfig({ PORT: "nope", GATE_MODE: "yolo", CG_FRESH: "maybe" }, "/app");
    } catch (error) {
      caught = error as ConfigError;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught?.problems).toHaveLength(3);
    expect(caught?.message).toContain("invalid configuration:");
  });

  it("leaves no partial result behind", () => {
    expect(() => loadConfig({ PORT: "nope" }, "/app")).toThrow(/PORT/);
  });
});

describe("istCalendarDate", () => {
  it("maps an instant to its IST calendar date at 00:00 UTC", () => {
    // 2026-11-17T19:00:00Z is 2026-11-18T00:30 IST.
    expect(istCalendarDate(new Date("2026-11-17T19:00:00Z")).toISOString()).toBe(
      "2026-11-18T00:00:00.000Z",
    );
    // 2026-11-18T18:00:00Z is still 2026-11-18 in IST (23:30).
    expect(istCalendarDate(new Date("2026-11-18T18:00:00Z")).toISOString()).toBe(
      "2026-11-18T00:00:00.000Z",
    );
  });

  it("rolls forward across the IST midnight boundary", () => {
    expect(istCalendarDate(new Date("2026-11-18T19:00:00Z")).toISOString()).toBe(
      "2026-11-19T00:00:00.000Z",
    );
  });
});

describe("temp database path handling", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a caller-supplied db path untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-config-"));
    dirs.push(dir);
    const target = join(dir, "nested", "cg.db");
    expect(loadConfig({ CG_DB_PATH: target }, "/app").dbPath).toBe(target);
  });
});
