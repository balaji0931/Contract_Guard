import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db/database.js";
import { loadKit } from "../src/pipeline/loadKit.js";
import { kitFingerprint } from "../src/loader/fingerprint.js";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Recorded baseline for the untouched starter kit (Phase 0 report). */
const KIT_BASELINE_DIGEST = "6a6b6988254f79a3e1d7a6c37fcf994c67bad4278f14c1a03371dbde7792cd87";

const dirs: string[] = [];
const handles: Array<Database> = [];
afterEach(() => {
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "cg-intake-"));
  dirs.push(dir);
  const { db } = openDatabase({ path: join(dir, "cg.db") });
  handles.push(db);
  return db;
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("loadKit reads the whole starter kit", () => {
  it("loads all 12 spec files and 4 consumers, versions taken from info.version", () => {
    const db = freshDb();
    const result = loadKit(KIT_ROOT, db);

    expect(result.specs).toHaveLength(12);
    expect(result.consumers).toHaveLength(4);

    const versionsByService = new Map<string, string[]>();
    for (const [service, intakes] of result.specsByService) {
      versionsByService.set(service, intakes.map((intake) => intake.version));
    }
    expect(versionsByService.get("quote-api")).toEqual(["1.0.0", "1.1.0", "2.0.0", "2.1.0"]);
    expect(versionsByService.get("policy-api")).toEqual(["1.0.0", "1.1.0", "2.0.0", "2.1.0"]);
    // Two files both declare 1.1.0: the corrected re-publication collides (L-2).
    expect(versionsByService.get("claims-api")).toEqual(["1.0.0", "1.1.0", "1.1.0", "2.0.0"]);

    const owners = new Map(
      [...result.specsByService.entries()].map(([service, intakes]) => [service, intakes[0]?.owner]),
    );
    expect(owners.get("quote-api")).toBe("Quotes team");
    expect(owners.get("policy-api")).toBe("Policy team");
    expect(owners.get("claims-api")).toBe("Claims team");
  });

  it("records intake rows in the registry tables", () => {
    const db = freshDb();
    const result = loadKit(KIT_ROOT, db);

    expect(count(db, "services")).toBe(3);
    expect(count(db, "spec_versions")).toBe(12);
    expect(count(db, "consumers")).toBe(4);

    const statuses = db.prepare("SELECT DISTINCT status FROM spec_versions").all() as Array<{
      status: string;
    }>;
    expect(statuses.map((row) => row.status)).toEqual(["staged"]);

    expect(result.summary.consumerUses).toBe(10);
    expect(result.summary.consumerUseFields).toBe(50);
    expect(count(db, "consumer_uses")).toBe(10);
    expect(count(db, "consumer_use_fields")).toBe(50);
  });

  it("re-running intake is idempotent so L-3 replays cannot duplicate rows", () => {
    const db = freshDb();
    loadKit(KIT_ROOT, db);
    const second = loadKit(KIT_ROOT, db);

    expect(count(db, "spec_versions")).toBe(12);
    expect(count(db, "consumers")).toBe(4);
    expect(count(db, "consumer_uses")).toBe(10);
    expect(count(db, "consumer_use_fields")).toBe(50);
    expect(count(db, "findings")).toBe(second.summary.findings);
  });
});

describe("validation against the kit's planted broken spec", () => {
  it("reports claims-api ClaimDocumnt as ERR_INVALID_SPEC without crashing", () => {
    const db = freshDb();
    const result = loadKit(KIT_ROOT, db);

    const claims = result.specsByService.get("claims-api") as NonNullable<
      ReturnType<typeof result.specsByService.get>
    >;
    const broken = claims.find((spec) => spec.fileName === "2-channel-and-notes.yaml");
    expect(broken).toBeDefined();
    expect(broken?.valid).toBe(false);
    expect(broken?.version).toBe("1.1.0");
    expect(broken?.issues.map((issue) => issue.code)).toEqual(["ERR_INVALID_SPEC"]);
    expect(broken?.issues[0]?.message).toMatch(/ClaimDocumnt/);

    expect(result.invalidSpecs.map((spec) => spec.fileName)).toEqual(["2-channel-and-notes.yaml"]);
  });

  it("accepts the corrected reference in 3-channel-and-notes-fixed.yaml", () => {
    const db = freshDb();
    const result = loadKit(KIT_ROOT, db);
    const claims = result.specsByService.get("claims-api") as never as Array<{
      fileName: string;
      valid: boolean;
      version: string;
    }>;

    const fixed = claims.find((spec) => spec.fileName === "3-channel-and-notes-fixed.yaml");
    expect(fixed).toBeDefined();
    expect(fixed?.valid).toBe(true);
    expect(fixed?.issues).toEqual([]);
    expect(fixed?.version).toBe("1.1.0");
  });

  it("considers the other ten specs structurally valid", () => {
    const db = freshDb();
    const result = loadKit(KIT_ROOT, db);
    const invalid = result.specs.filter((spec) => !spec.valid);
    expect(invalid).toHaveLength(1);
  });

  it("stores the invalid-spec finding against the right registry row", () => {
    const db = freshDb();
    loadKit(KIT_ROOT, db);

    const rows = db
      .prepare(
        `SELECT sv.source_file, sv.version, f.code, f.severity, f.message
         FROM findings f
         JOIN spec_versions sv ON sv.id = f.spec_version_id`,
      )
      .all() as Array<{ source_file: string; version: string; code: string; severity: string; message: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_file: "specs/claims-api/2-channel-and-notes.yaml",
      version: "1.1.0",
      code: "ERR_INVALID_SPEC",
      severity: "blocking",
    });
  });
});

describe("consumer manifests are indexed", () => {
  it("captures every team, call and field path", () => {
    const db = freshDb();
    const result = loadKit(KIT_ROOT, db);

    const byName = new Map(result.consumers.map((consumer) => [consumer.name, consumer]));
    expect([...byName.keys()].sort()).toEqual([
      "mobile-app",
      "notifications-svc",
      "partner-portal",
      "payments-svc",
    ]);
    expect(byName.get("mobile-app")?.team).toBe("Mobile");
    expect(byName.get("partner-portal")?.team).toBe("Partner Integrations");
    expect(byName.get("payments-svc")?.team).toBe("Payments");
    expect(byName.get("notifications-svc")?.team).toBe("Notifications");

    expect(byName.get("mobile-app")?.uses).toHaveLength(4);
    expect(byName.get("partner-portal")?.uses).toHaveLength(2);
    expect(byName.get("payments-svc")?.uses).toHaveLength(1);
    expect(byName.get("notifications-svc")?.uses).toHaveLength(3);
    for (const consumer of result.consumers) expect(consumer.valid).toBe(true);

    // Paths are stored exactly as the manifest wrote them, plus the normalized form.
    const mobileQuoteGet = byName.get("mobile-app")?.uses.find((use) => use.method === "GET");
    expect(mobileQuoteGet?.pathTemplate).toBe("/quotes/{id}");
    expect(mobileQuoteGet?.normalizedPath).toBe("/quotes/{}");

    const mobileQuotePost = byName.get("mobile-app")?.uses.find(
      (use) => use.method === "POST" && use.provider === "quote-api",
    );
    expect(mobileQuotePost?.reads).toContain("premium.breakdown[].amount");
    expect(mobileQuotePost?.sends).toEqual(["vehicle.make", "vehicle.cc", "rider.age"]);

    expect(byName.get("payments-svc")?.uses[0]?.reads).toContain("legacyCode");

    const partnerEndorsement = byName
      .get("partner-portal")
      ?.uses.find((use) => use.pathTemplate.includes("endorsements"));
    expect(partnerEndorsement?.sends).toEqual(["policyId", "type", "details"]);
    expect(partnerEndorsement?.sends).not.toContain("requestedBy");
  });
});

describe("the kit stays read-only", () => {
  it("leaves specs/ and consumers/ byte-identical after a full intake", () => {
    const before = kitFingerprint(KIT_ROOT);
    expect(before.fileCount).toBe(16);
    expect(before.digest).toBe(KIT_BASELINE_DIGEST);

    const db = freshDb();
    loadKit(KIT_ROOT, db);

    const after = kitFingerprint(KIT_ROOT);
    expect(after.digest).toBe(before.digest);
    expect(after.digest).toBe(KIT_BASELINE_DIGEST);
  });
});
