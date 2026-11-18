/**
 * Discovery of the starter kit's read-only inputs (locked decision PO-4 / D-7).
 *
 * `specs/<service>/<n>-<name>.yaml` — service identity is the folder name,
 * because that is what consumer manifests reference as `provider`.
 * Publication order comes from the numeric filename prefix, never the version.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ConfigError } from "../config.js";

export interface SpecFileRef {
  /** Folder name under `specs/`, e.g. `quote-api`. */
  service: string;
  /** Numeric filename prefix; files without one sort last. */
  order: number;
  fileName: string;
  /** Path relative to the kit root, e.g. `specs/quote-api/1-initial.yaml`. */
  relativePath: string;
  absolutePath: string;
}

export interface ConsumerFileRef {
  /** Consumer name derived from the file stem, e.g. `mobile-app`. */
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
}

const SPEC_EXTENSIONS = /\.ya?ml$/i;
const ORDER_PREFIX = /^(\d+)(?:[-_\s]|$)/;

/** Leading integer of `3-price-lines.yaml` → 3; unprefixed names sort last. */
export function publishOrderOf(fileName: string): number {
  const match = ORDER_PREFIX.exec(fileName);
  return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function isFile(path: string, label: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new ConfigError([`${label} does not exist: ${path}`]);
  }
  if (!stats.isDirectory()) throw new ConfigError([`${label} is not a directory: ${path}`]);
}

function listYamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SPEC_EXTENSIONS.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => publishOrderOf(a) - publishOrderOf(b) || a.localeCompare(b));
}

/** All spec files, grouped per service and ordered by publication order. */
export function discoverSpecFiles(kitRoot: string): Map<string, SpecFileRef[]> {
  const specsRoot = join(kitRoot, "specs");
  isFile(specsRoot, "specs root");

  const services = readdirSync(specsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const grouped = new Map<string, SpecFileRef[]>();
  for (const service of services) {
    const files = listYamlFiles(join(specsRoot, service)).map((fileName) => ({
      service,
      order: publishOrderOf(fileName),
      fileName,
      relativePath: `specs/${service}/${fileName}`,
      absolutePath: join(specsRoot, service, fileName),
    }));
    if (files.length > 0) grouped.set(service, files);
  }
  return grouped;
}

/** Every spec file in one flat list, service by service in publication order. */
export function discoverSpecFileList(kitRoot: string): SpecFileRef[] {
  return [...discoverSpecFiles(kitRoot).values()].flat();
}

/** Consumer manifests, sorted by consumer name for deterministic intake. */
export function discoverConsumerFiles(kitRoot: string): ConsumerFileRef[] {
  const consumersRoot = join(kitRoot, "consumers");
  isFile(consumersRoot, "consumers root");

  return listYamlFiles(consumersRoot).map((fileName) => ({
    name: fileName.replace(/\.ya?ml$/i, ""),
    fileName,
    relativePath: `consumers/${fileName}`,
    absolutePath: join(consumersRoot, fileName),
  }));
}
