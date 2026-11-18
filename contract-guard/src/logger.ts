/**
 * Minimal leveled logger. No dependency: the receiver and demo need readable
 * startup output, not a logging framework.
 */

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function thresholdFor(name: string): number {
  const index = LEVELS.indexOf(name.trim().toLowerCase() as Level);
  return index === -1 ? LEVELS.indexOf("info") : index;
}

function format(level: Level, message: string, bindings: Record<string, unknown>): string {
  const stamp = new Date().toISOString();
  const extras = Object.keys(bindings).length
    ? ` ${Object.entries(bindings)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(" ")}`
    : "";
  return `${stamp} ${level.toUpperCase().padEnd(5)} ${message}${extras}`;
}

function emit(
  stream: (line: string) => void,
  minIndex: number,
  bindings: Record<string, unknown>,
): Logger {
  const make = (level: Level) => (message: string, fields?: Record<string, unknown>) => {
    if (LEVELS.indexOf(level) < minIndex) return;
    stream(format(level, message, { ...bindings, ...fields }));
  };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child: (extra) => emit(stream, minIndex, { ...bindings, ...extra }),
  };
}

export function createLogger(options: { level?: string } = {}): Logger {
  const minIndex = thresholdFor(options.level ?? "info");
  const stdout = (line: string) => process.stdout.write(`${line}\n`);
  const stderr = (line: string) => process.stderr.write(`${line}\n`);

  const out = emit(stdout, minIndex, {});
  const err = emit(stderr, minIndex, {});
  return {
    debug: out.debug,
    info: out.info,
    // Warnings and errors go to stderr so demo output stays readable and pipelines can filter them.
    warn: err.warn,
    error: err.error,
    child: (bindings) => createChild(bindings, minIndex, out, err),
  };
}

function createChild(
  bindings: Record<string, unknown>,
  minIndex: number,
  out: Logger,
  err: Logger,
): Logger {
  return {
    debug: (message, fields) => out.debug(message, { ...bindings, ...fields }),
    info: (message, fields) => out.info(message, { ...bindings, ...fields }),
    warn: (message, fields) => err.warn(message, { ...bindings, ...fields }),
    error: (message, fields) => err.error(message, { ...bindings, ...fields }),
    child: (extra) => createChild({ ...bindings, ...extra }, minIndex, out, err),
  };
}
