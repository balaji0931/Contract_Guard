/**
 * Shared read model for the HTTP API and dashboard (Phase 8).
 *
 * The registry's truth is the SQLite database; the gate additionally needs the
 * in-memory wire indexes for baseline diffing. Every request builds a fresh
 * view: re-run `indexKit` (idempotent per Phase 1/2 design) to get the kit
 * candidates and wire indexes, then merge any specs uploaded through
 * `POST /api/specs` this process (their DB rows persist; the parsed wire index
 * lives here so the gate can diff against them until the next startup replay).
 */

import type { Database } from "../db/database.js";
import type { Config } from "../config.js";
import { indexKit, type KitIndexResult } from "../pipeline/indexKit.js";
import { candidatesForGate, type GateCandidate } from "../gate/publicationGate.js";

export interface RegistryView {
  index: KitIndexResult;
  /** Every candidate for the gate: kit files plus this process's uploads. */
  candidates: GateCandidate[];
  /** Candidates per service, in publication (filename) order. */
  byService: Map<string, GateCandidate[]>;
}

export class RegistryState {
  private uploads: GateCandidate[] = [];

  /** Remember (or replace) a manual upload's candidate for future gating. */
  addUpload(candidate: GateCandidate): void {
    this.uploads = this.uploads.filter((item) => item.sourceFile !== candidate.sourceFile);
    this.uploads.push(candidate);
  }

  uploadFor(sourceFile: string): GateCandidate | undefined {
    return this.uploads.find((candidate) => candidate.sourceFile === sourceFile);
  }

  /** Fresh per-request view (kit re-indexed from disk, statuses from DB). */
  view(db: Database, config: Config): RegistryView {
    const index = indexKit(config.kitRoot, db);
    const kitCandidates = candidatesForGate(index.specs, index.load.specs);
    const knownFiles = new Set(kitCandidates.map((candidate) => candidate.sourceFile));
    const candidates = [
      ...kitCandidates,
      ...this.uploads.filter((candidate) => !knownFiles.has(candidate.sourceFile)),
    ];

    const byService = new Map<string, GateCandidate[]>();
    for (const candidate of candidates) {
      byService.set(candidate.service, [
        ...(byService.get(candidate.service) ?? []),
        candidate,
      ]);
    }
    for (const versions of byService.values()) {
      versions.sort((left, right) => left.order - right.order);
    }
    return { index, candidates, byService };
  }
}
