/**
 * Configuration for Contract Guard, read from environment variables.
 *
 * Every value is validated. `loadConfig` throws a `ConfigError` that lists ALL
 * problems at once with the offending variable named, so a misconfigured
 * startup fails clearly and immediately instead of failing partially later.
 */

export const GATE_MODES = ["consumer", "strict"] as const;
export type GateMode = (typeof GATE_MODES)[number];

export interface Config {
  /** HTTP port for the Contract Guard API + dashboard. */
  port: number;
  /** Base URL of the webhook receiver that stands in for chat/email. */
  webhookUrl: string;
  /** SQLite file path, or ":memory:" for tests. */
  dbPath: string;
  /** "Today" used for `x-sunset` comparisons. Defaults to the real date. */
  asOfDate: Date;
  /** Whether the pinned as-of date came from CG_AS_OF_DATE (true) or the clock (false). */
  asOfDatePinned: boolean;
  /** Gate policy. Default "consumer" (locked decision L-1). */
  gateMode: GateMode;
  /** Replay the whole pipeline at startup (locked decision L-3). Default true. */
  fresh: boolean;
  /** Folder containing the read-only `specs/` and `consumers/` directories. */
  kitRoot: string;
  /** Absolute path to this app's own directory. */
  appRoot: string;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULT_WEBHOOK_URL = "http://localhost:9900";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an integer env var within [min, max]; never throws, records problems instead. */
function readPort(
  env: NodeJS.ProcessEnv,
  problems: string[],
): number | undefined {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === "") return 5000;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    problems.push(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  return value;
}

function readWebhookUrl(
  env: NodeJS.ProcessEnv,
  problems: string[],
): string | undefined {
  const raw = env.WEBHOOK_URL?.trim() || DEFAULT_WEBHOOK_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    problems.push(`WEBHOOK_URL must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    problems.push(`WEBHOOK_URL must use http or https, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  return parsed.toString().replace(/\/$/, "");
}

/**
 * `x-sunset` dates are calendar dates in IST (locked decision L-4). The as-of
 * date is likewise interpreted as the IST calendar date, at 00:00 UTC so it is
 * directly comparable with parsed sunset dates.
 */
function readAsOfDate(
  env: NodeJS.ProcessEnv,
  problems: string[],
): { date: Date; pinned: boolean } | undefined {
  const raw = env.CG_AS_OF_DATE?.trim();
  if (raw === undefined || raw === "") {
    return { date: istCalendarDate(new Date()), pinned: false };
  }
  if (!ISO_DATE.test(raw)) {
    problems.push(`CG_AS_OF_DATE must be YYYY-MM-DD, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  const [year, month, day] = raw.split("-").map(Number) as [number, number, number];
  // Reject impossible dates such as 2026-02-31, which Date would silently roll over.
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    problems.push(`CG_AS_OF_DATE must be a real calendar date, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    problems.push(`CG_AS_OF_DATE must be a real calendar date, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  return { date: probe, pinned: true };
}

/** Reduce an instant to its IST calendar date, normalised to 00:00 UTC. */
export function istCalendarDate(instant: Date): Date {
  const ist = new Date(instant.getTime() + 5.5 * 60 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

function readGateMode(
  env: NodeJS.ProcessEnv,
  problems: string[],
): GateMode | undefined {
  const raw = env.GATE_MODE?.trim().toLowerCase() || "consumer";
  if (!GATE_MODES.includes(raw as GateMode)) {
    problems.push(`GATE_MODE must be one of ${GATE_MODES.join(", ")}, got ${JSON.stringify(env.GATE_MODE)}`);
    return undefined;
  }
  return raw as GateMode;
}

/** `CG_FRESH` defaults to enabled: demos must replay the pipeline on every launch. */
function readFresh(env: NodeJS.ProcessEnv, problems: string[]): boolean | undefined {
  const raw = env.CG_FRESH?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  problems.push(`CG_FRESH must be a boolean (1/0, true/false), got ${JSON.stringify(env.CG_FRESH)}`);
  return undefined;
}

/**
 * Resolve configuration from an environment object.
 * @throws {ConfigError} when any variable is missing-or-malformed.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  appRoot = process.cwd(),
): Config {
  const problems: string[] = [];

  const port = readPort(env, problems);
  const webhookUrl = readWebhookUrl(env, problems);
  const asOf = readAsOfDate(env, problems);
  const gateMode = readGateMode(env, problems);
  const fresh = readFresh(env, problems);

  const dbPath = env.CG_DB_PATH?.trim() || `${appRoot}/data/contract-guard.db`;

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port: port as number,
    webhookUrl: webhookUrl as string,
    dbPath,
    asOfDate: (asOf as { date: Date }).date,
    asOfDatePinned: (asOf as { pinned: boolean }).pinned,
    gateMode: gateMode as GateMode,
    fresh: fresh as boolean,
    kitRoot: env.KIT_ROOT?.trim() || `${appRoot}/..`,
    appRoot,
  };
}
