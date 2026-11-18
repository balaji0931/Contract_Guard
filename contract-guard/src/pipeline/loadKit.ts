/**
 * Phase 1 pipeline: discover the local kit, load and validate every file, and
 * record intake results. Later phases add the gate and notifier around this;
 * Phase 7 calls it from the startup sequence.
 */
import type { Database } from "../db/database.js";
import type { Logger } from "../logger.js";
import { discoverConsumerFiles, discoverSpecFiles, type SpecFileRef } from "../loader/discovery.js";
import { loadConsumerFile, type ConsumerIntake } from "../loader/consumerLoader.js";
import { loadSpecFile, type SpecIntake } from "../loader/specLoader.js";
import { recordIntake, type IntakeSummary } from "../registry/intakeStore.js";

export interface KitLoadResult {
  /** Spec intakes grouped by service, each service in publication order. */
  specsByService: Map<string, SpecIntake[]>;
  /** Flat list in service order, then publication order. */
  specs: SpecIntake[];
  consumers: ConsumerIntake[];
  summary: IntakeSummary;
  invalidSpecs: SpecIntake[];
}

function describe(ref: SpecFileRef): string {
  return `${ref.relativePath}`;
}

export function loadKit(kitRoot: string, db: Database, logger?: Logger): KitLoadResult {
  const log = logger;
  const grouped = discoverSpecFiles(kitRoot);

  const specsByService = new Map<string, SpecIntake[]>();
  const specs: SpecIntake[] = [];
  for (const [service, refs] of grouped) {
    const intakes = refs.map((ref) => {
      const intake = loadSpecFile(ref);
      log?.debug("spec intake", {
        file: describe(ref),
        version: intake.version,
        valid: intake.valid,
        issues: intake.issues.length,
      });
      return intake;
    });
    specsByService.set(service, intakes);
    specs.push(...intakes);
  }

  const consumerRefs = discoverConsumerFiles(kitRoot);
  const consumers = consumerRefs.map((ref) => {
    const intake = loadConsumerFile(ref);
    log?.debug("consumer intake", {
      file: ref.relativePath,
      uses: intake.uses.length,
      valid: intake.valid,
    });
    return intake;
  });

  const summary = recordIntake(db, specs, consumers);
  const invalidSpecs = specs.filter((spec) => !spec.valid);

  log?.info("kit intake complete", {
    services: new Set(specs.map((spec) => spec.service)).size,
    specVersions: specs.length,
    consumers: consumers.length,
    invalidSpecs: invalidSpecs.length,
    findings: summary.findings,
  });

  return { specsByService, specs, consumers, summary, invalidSpecs };
}
