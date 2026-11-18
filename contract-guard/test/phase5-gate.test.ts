import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db/database.js";
import { indexKit, type KitIndexResult } from "../src/pipeline/indexKit.js";
import {
  candidatesForGate,
  nextVersionAfter,
  runPublicationGate,
  type GateCandidate,
  type GateVerdict,
} from "../src/gate/publicationGate.js";
import type { GateMode } from "../src/config.js";
import type { ConsumerUseIndex } from "../src/consumers/consumerIndex.js";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const AS_OF = new Date(Date.UTC(2026, 10, 18));

const dirs: string[] = [];
const handles: Array<Database> = [];
afterAll(() => {
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Fixture {
  db: Database;
  index: KitIndexResult;
  candidates: GateCandidate[];
}

function newFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "cg-gate-"));
  dirs.push(dir);
  const { db } = openDatabase({ path: join(dir, "cg.db") });
  handles.push(db);
  const index = indexKit(KIT_ROOT, db);
  const candidates = candidatesForGate(index.specs, index.load.specs);
  return { db, index, candidates };
}

function forService(fixture: Fixture, service: string): GateCandidate[] {
  return fixture.candidates
    .filter((candidate) => candidate.service === service)
    .sort((left, right) => left.order - right.order);
}

function gate(
  fixture: Fixture,
  service: string,
  orderOrPrefix: number | string,
  options: {
    mode?: GateMode;
    consumerIndex?: ConsumerUseIndex[];
    fault?: () => void;
  } = {},
): GateVerdict {
  const versions = forService(fixture, service);
  const candidate = versions.find((version) =>
    typeof orderOrPrefix === "number"
      ? version.order === orderOrPrefix
      : version.sourceFile.includes(`/${orderOrPrefix}`),
  );
  expect(candidate, `${service} candidate ${String(orderOrPrefix)}`).toBeDefined();
  return runPublicationGate(fixture.db, candidate as GateCandidate, {
    mode: options.mode ?? "consumer",
    asOfDate: AS_OF,
    consumerIndex: options.consumerIndex ?? fixture.index.consumers,
    serviceVersions: versions,
    fault: options.fault,
  });
}

function rowOf(fixture: Fixture, service: string, sourceFilePart: string) {
  const row = fixture.db
    .prepare(
      `SELECT sv.status, sv.outcome_reason_code, sv.decided_at
       FROM spec_versions sv JOIN services s ON s.id = sv.service_id
       WHERE s.name = ? AND sv.source_file LIKE ?`,
    )
    .get(service, `%${sourceFilePart}%`) as
    | { status: string; outcome_reason_code: string | null; decided_at: string | null }
    | undefined;
  expect(row, `${service}/${sourceFilePart}`).toBeDefined();
  return row as { status: string; outcome_reason_code: string | null; decided_at: string | null };
}

function events(fixture: Fixture): Array<{ kind: string; service: string; version: string; outcome: string; detail: string }> {
  return fixture.db
    .prepare("SELECT kind, service, version, outcome, detail FROM events ORDER BY id")
    .all() as never;
}

describe("first valid version publishes", () => {
  it("quote-api 1.0.0 and 1.1.0 both publish, baseline is `first` then previous", () => {
    const fixture = newFixture();
    const first = gate(fixture, "quote-api", 1);
    expect(first.outcome).toBe("published");
    expect(first.reasonCodes).toEqual([]);
    expect(first.baseline).toBe("first");
    expect(first.impacts).toEqual([]);
    expect(rowOf(fixture, "quote-api", "1-initial")).toMatchObject({
      status: "published",
      outcome_reason_code: "",
    });
    expect(rowOf(fixture, "quote-api", "1-initial")?.decided_at).toBeTruthy();

    const second = gate(fixture, "quote-api", 2);
    expect(second.outcome).toBe("published");
    expect(second.baseline).toBe("previous");
    expect(second.reasonCodes).toEqual([]);
  });
});

describe("consumer-impacting candidate blocks without becoming baseline (D-4)", () => {
  it("quote 2.0.0 blocks on mobile impact; 2.1.0 still diffs against 1.1.0", () => {
    const fixture = newFixture();
    gate(fixture, "quote-api", 1);
    gate(fixture, "quote-api", 2);

    const blocked = gate(fixture, "quote-api", 3);
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.reasonCodes).toContain("ERR_BREAKING_FIELD_REMOVED");
    expect(blocked.impacts.map((impact) => impact.consumer)).toContain("mobile-app");
    expect(rowOf(fixture, "quote-api", "3-price-lines")?.status).toBe("blocked");

    // The blocked version never becomes baseline: the cascade is detected.
    const cascade = gate(fixture, "quote-api", 4);
    expect(cascade.outcome).toBe("blocked");
    expect(
      cascade.impacts.find((impact) => impact.fieldPath === "premium.breakdown[].amount"),
    ).toBeDefined();
    const detail = JSON.parse(events(fixture).at(-1)?.detail ?? "{}");
    expect(detail.baseline).toBe("specs/quote-api/2-reorganised.yaml");
  });

  it("impact findings carry the consumer attribution in the registry", () => {
    const fixture = newFixture();
    gate(fixture, "quote-api", 1);
    gate(fixture, "quote-api", 2);
    gate(fixture, "quote-api", 3);

    const attributed = fixture.db
      .prepare(
        `SELECT c.name AS consumer, f.code, f.field_path
         FROM findings f
         JOIN spec_versions sv ON sv.id = f.spec_version_id
         JOIN services s ON s.id = sv.service_id
         JOIN consumers c ON c.id = f.consumer_id
         WHERE s.name = 'quote-api' AND sv.source_file LIKE '%3-price-lines%'`,
      )
      .all() as Array<{ consumer: string; code: string; field_path: string }>;
    expect(attributed).toEqual([
      expect.objectContaining({
        consumer: "mobile-app",
        code: "ERR_BREAKING_FIELD_REMOVED",
        field_path: "premium.breakdown[].amount",
      }),
    ]);
  });
});

describe("unconsumed breaking changes publish with WARN_UNCONSUMED_BREAKING (L-1)", () => {
  it("claims 2.0.0 publishes when no consumer is exposed; strict mode blocks it", () => {
    // Consumer mode: strip every claims-api consumer from the index.
    const consumerFixture = newFixture();
    const claimsUsers = consumerFixture.index.consumers.filter(
      (use) => use.provider === "claims-api",
    );
    expect(claimsUsers.length).toBeGreaterThan(0);
    const unbiased = consumerFixture.index.consumers.filter(
      (use) => use.provider !== "claims-api",
    );

    gate(consumerFixture, "claims-api", 1);
    const unconsumed = gate(consumerFixture, "claims-api", 4, { consumerIndex: unbiased });
    expect(unconsumed.outcome).toBe("published");
    expect(unconsumed.reasonCodes).toEqual([]);
    expect(
      unconsumed.gateFindings.map((item) => item.code),
    ).toContain("WARN_UNCONSUMED_BREAKING");
    expect(rowOf(consumerFixture, "claims-api", "4-approval-later")?.status).toBe("published");

    // The same candidate under `strict` blocks.
    const strictFixture = newFixture();
    gate(strictFixture, "claims-api", 1);
    const strict = gate(strictFixture, "claims-api", 4, {
      mode: "strict",
      consumerIndex: unbiased,
    });
    expect(strict.outcome).toBe("blocked");
    expect(strict.reasonCodes).toContain("ERR_BREAKING_FIELD_NOW_OPTIONAL");
  });

  it("a future-sunset removal with no consumer is unconsumed, not sunset-blocked", () => {
    const fixture = newFixture();
    // Empty consumer index: policy 2.0.0 removes holder.phone (sunset 2027-06-30)
    // and legacyCode (past sunset). Only the past-sunset one may block.
    gate(fixture, "policy-api", 1);
    expect(gate(fixture, "policy-api", 2).outcome).toBe("published");
    const verdict = gate(fixture, "policy-api", 3, { consumerIndex: [] });
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.reasonCodes).toEqual(["ERR_SUNSET_REMOVAL_EXPIRED"]);
    // holder.phone is the unconsumed warning, not a reason.
    const phoneWarnings = verdict.gateFindings.filter(
      (item) => item.fieldPath === "holder.phone",
    );
    expect(phoneWarnings.map((item) => item.code)).toContain("WARN_UNCONSUMED_BREAKING");
  });
});

describe("duplicate-version outcomes follow L-2", () => {
  it("the corrected claims 1.1.0 is rejected with next-number guidance", () => {
    const fixture = newFixture();
    gate(fixture, "claims-api", 1);
    const invalid = gate(fixture, "claims-api", 2);
    expect(invalid.outcome).toBe("blocked");
    expect(invalid.reasonCodes).toEqual(["ERR_INVALID_SPEC"]);

    const duplicate = gate(fixture, "claims-api", 3);
    expect(duplicate.outcome).toBe("rejected");
    expect(duplicate.reasonCodes).toEqual(["ERR_DUPLICATE_VERSION"]);
    expect(duplicate.gateFindings[0]?.message).toMatch(/publish this as 1\.1\.1/);
    expect(rowOf(fixture, "claims-api", "3-channel-and-notes-fixed")?.status).toBe("rejected");

    // Blocked-invalid intake still reserved the number (L-2).
    const row = fixture.db
      .prepare(
        `SELECT sv.status FROM spec_versions sv JOIN services s ON s.id = sv.service_id
         WHERE s.name = 'claims-api' AND sv.source_file LIKE '%2-channel-and-notes.yaml'`,
      )
      .get() as { status: string };
    expect(row.status).toBe("blocked");
  });

  it("suggested numbers advance sensibly", () => {
    expect(nextVersionAfter("1.1.0")).toBe("1.1.1");
    expect(nextVersionAfter("2.0.3")).toBe("2.0.4");
    expect(nextVersionAfter("v9")).toBe("v9.1");
  });
});

describe("invalid-spec outcome is a distinct block reason", () => {
  it("claims 2-channel blocks on ERR_INVALID_SPEC with no diff performed", () => {
    const fixture = newFixture();
    gate(fixture, "claims-api", 1);
    const verdict = gate(fixture, "claims-api", 2);
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.reasonCodes).toEqual(["ERR_INVALID_SPEC"]);
    expect(verdict.impacts).toEqual([]);
    // The intake finding remains on the row.
    const codes = (
      fixture.db
        .prepare(
          `SELECT f.code FROM findings f
           JOIN spec_versions sv ON sv.id = f.spec_version_id
           JOIN services s ON s.id = sv.service_id
           WHERE s.name = 'claims-api' AND sv.source_file LIKE '%2-channel-and-notes.yaml'`,
        )
        .all() as Array<{ code: string }>
    ).map((row) => row.code);
    expect(codes).toContain("ERR_INVALID_SPEC");
  });
});

describe("later candidates compare with last published version", () => {
  it("policy 2.1.0 cascades against 1.1.0 after 2.0.0 blocks", () => {
    const fixture = newFixture();
    gate(fixture, "policy-api", 1);
    gate(fixture, "policy-api", 2);
    expect(gate(fixture, "policy-api", 3).outcome).toBe("blocked");

    const cascade = gate(fixture, "policy-api", 4);
    expect(cascade.outcome).toBe("blocked");
    expect(cascade.reasonCodes).toEqual(
      expect.arrayContaining([
        "ERR_BREAKING_FIELD_NOW_REQUIRED",
        "ERR_BREAKING_ENUM_VALUE_REMOVED",
        "ERR_SUNSET_REMOVAL_EXPIRED",
      ]),
    );
    const detail = JSON.parse(events(fixture).at(-1)?.detail ?? "{}");
    expect(detail.baseline).toBe("specs/policy-api/2-deprecations.yaml");
  });
});

describe("verdict, findings and audit commit atomically", () => {
  it("a mid-transaction failure rolls the verdict and audit back together", () => {
    const fixture = newFixture();
    const before = rowOf(fixture, "quote-api", "1-initial");
    expect(before.status).toBe("staged");

    expect(() =>
      gate(fixture, "quote-api", 1, {
        fault: () => {
          throw new Error("simulated db failure");
        },
      }),
    ).toThrow(/simulated db failure/);

    // Nothing persisted: still staged, no audit row, no decided_at.
    expect(rowOf(fixture, "quote-api", "1-initial")?.status).toBe("staged");
    expect(rowOf(fixture, "quote-api", "1-initial")?.decided_at).toBeNull();
    expect(events(fixture)).toHaveLength(0);

    // A clean retry decides normally.
    expect(gate(fixture, "quote-api", 1).outcome).toBe("published");
    const audit = events(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: "gate_decision",
      service: "quote-api",
      version: "1.0.0",
      outcome: "published",
    });
    expect(JSON.parse(audit[0]?.detail ?? "{}").mode).toBe("consumer");
  });
});

describe("full acceptance-matrix run at the gate level", () => {
  it("the 12 kit files decide 5 published / 6 blocked / 1 rejected", () => {
    const fixture = newFixture();
    const outcomes: string[] = [];
    for (const service of ["claims-api", "policy-api", "quote-api"]) {
      for (const candidate of forService(fixture, service)) {
        outcomes.push(
          runPublicationGate(fixture.db, candidate, {
            mode: "consumer",
            asOfDate: AS_OF,
            consumerIndex: fixture.index.consumers,
            serviceVersions: forService(fixture, service),
          }).outcome,
        );
      }
    }
    expect(outcomes.filter((outcome) => outcome === "published")).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome === "blocked")).toHaveLength(6);
    expect(outcomes.filter((outcome) => outcome === "rejected")).toHaveLength(1);
    expect(fixture.index.specs).toHaveLength(12);
  });
});
