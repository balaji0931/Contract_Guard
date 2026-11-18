/**
 * Baseline selection (locked decision D-4): a candidate always compares against
 * the last *published* version of its service; blocked, rejected and invalid
 * versions never become baselines, which is what makes cascading blocks
 * (quote-api 2.1.0 vs 1.1.0, policy 2.1.0 vs 1.1.0) the expected behaviour.
 */
import { diffWireIndexes, type DiffOptions } from "./wireDiff.js";
import type { Finding } from "../findings/codes.js";
import type { IndexedOperation } from "../wire/operationIndex.js";

/** Where a version sits in its service's publication order. */
export interface VersionLike<T> {
  /** Filename order within the service (smaller = earlier). */
  order: number;
  status: string;
  value: T;
}

/** The candidate itself: first valid version of a service has no baseline. */
export type Baseline<T> =
  | { kind: "first" }
  | { kind: "previous"; version: VersionLike<T> };

/**
 * Pick the baseline for one candidate: the highest-`order` version already
 * marked `published` (the candidate itself excluded). Statuses come from the
 * registry, so callers pass real gate decisions, never guesses.
 */
export function selectBaseline<T>(
  orderedVersions: VersionLike<T>[],
  candidate: VersionLike<T>,
): Baseline<T> {
  const published = orderedVersions
    .filter(
      (version) =>
        version.status === "published" &&
        version.order < candidate.order &&
        version !== candidate,
    )
    .sort((left, right) => left.order - right.order);

  const previous = published.at(-1);
  return previous === undefined ? { kind: "first" } : { kind: "previous", version: previous };
}

/** Operations paired with the gate status of the version that carries them. */
export interface VersionOperations {
  order: number;
  status: string;
  operations: IndexedOperation[];
}

/**
 * Diff one candidate against its last-published baseline, or report the
 * first-version case with no findings to diff.
 */
export function diffAgainstBaseline(
  orderedVersions: VersionOperations[],
  candidate: VersionOperations,
  options: DiffOptions,
): { findings: Finding[]; baseline: "first" | "previous" } {
  const asVersions = orderedVersions.map((version) => ({
    order: version.order,
    status: version.status,
    value: version.operations,
  }));
  const candidateVersion = asVersions.find((version) => version.order === candidate.order);
  const baseline = selectBaseline(
    asVersions,
    candidateVersion ?? { order: candidate.order, status: candidate.status, value: candidate.operations },
  );
  if (baseline.kind === "first") return { findings: [], baseline: "first" };
  return {
    findings: diffWireIndexes(baseline.version.value, candidate.operations, options),
    baseline: "previous",
  };
}
