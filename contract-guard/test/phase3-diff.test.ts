import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db/database.js";
import { indexKit, findIndexedSpec, type KitIndexResult } from "../src/pipeline/indexKit.js";
import { collectParamAliases, diffWireIndexes } from "../src/diff/wireDiff.js";
import { diffAgainstBaseline, selectBaseline } from "../src/diff/baseline.js";
import { parseCalendarDate, sunsetExpired } from "../src/domain/sunsets.js";
import { parseYaml } from "../src/loader/readFile.js";
import { indexOperations } from "../src/wire/operationIndex.js";
import type { Finding } from "../src/findings/codes.js";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** The pinned acceptance date (locked decision L-4). */
const AS_OF = new Date(Date.UTC(2026, 10, 18));

const dirs: string[] = [];
const handles: Array<Database> = [];
afterAll(() => {
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

let cached: KitIndexResult | undefined;
function indexed(): KitIndexResult {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "cg-diff-"));
  dirs.push(dir);
  const { db } = openDatabase({ path: join(dir, "cg.db") });
  handles.push(db);
  cached = indexKit(KIT_ROOT, db);
  return cached;
}

function specOf(service: string, prefix: string) {
  const spec = findIndexedSpec(indexed(), service, prefix);
  expect(spec, `missing ${service}/${prefix}`).toBeDefined();
  return spec as NonNullable<typeof spec>;
}

function diff(service: string, basePrefix: string, candPrefix: string): Finding[] {
  return diffWireIndexes(
    specOf(service, basePrefix).operations,
    specOf(service, candPrefix).operations,
    { asOfDate: AS_OF },
  );
}

function codesOf(findings: Finding[]): string[] {
  return findings.map((item) => item.code);
}

function blocking(findings: Finding[]): Finding[] {
  return findings.filter((item) => item.severity === "blocking");
}

describe("quote-api 1.0.0 → 1.1.0: pure refactor", () => {
  it("has no findings of any kind — the wire index is unchanged", () => {
    expect(diff("quote-api", "1-", "2-")).toEqual([]);
  });

  it("records the id→quoteId parameter alias instead of a false alarm (D-3)", () => {
    const aliases = collectParamAliases(
      specOf("quote-api", "1-").operations,
      specOf("quote-api", "2-").operations,
    );
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({
      operationRef: "GET /quotes/{quoteId}",
      baselinePath: "/quotes/{id}",
      candidatePath: "/quotes/{quoteId}",
      aliasMap: { id: "quoteId" },
    });
  });
});

describe("quote-api 1.1.0 → 2.0.0: the price-line rename", () => {
  const findings = diff("quote-api", "2-", "3-");

  it("detects premium.breakdown[].amount removal as breaking", () => {
    // The Quote response schema is shared: GET and POST both return `premium`.
    const removed = findings.filter(
      (item) =>
        item.code === "ERR_BREAKING_FIELD_REMOVED" &&
        item.fieldPath === "premium.breakdown[].amount",
    );
    expect(removed.map((item) => item.operationRef).sort()).toEqual([
      "GET /quotes/{quoteId}",
      "POST /quotes",
    ]);
    expect(removed.every((item) => item.severity === "blocking")).toBe(true);
  });

  it("treats the new `value` field as additive, not breaking", () => {
    expect(findings.filter((item) => item.fieldPath === "premium.breakdown[].value")).toEqual([]);
    expect(findings.filter((item) => item.fieldPath === "premium.breakdown")).toEqual([]);
  });

  it("notes the new required `region` param on the x-internal op without blocking (PO-1)", () => {
    const internal = findings.filter((item) =>
      (item.operationRef ?? "").includes("pricing-cache"),
    );
    expect(codesOf(internal)).toContain("WARN_INTERNAL_CHANGE_NOTED");
    expect(blocking(internal)).toEqual([]);
    const note = internal.find((item) => item.fieldPath === "region");
    expect(note?.message).toMatch(/required/);
  });

  it("warns about the added EXPIRED status enum value (exhaustive-switch risk)", () => {
    const added = findings.find((item) => item.code === "WARN_ENUM_VALUE_ADDED");
    expect(added).toMatchObject({ severity: "warning", fieldPath: "status" });
    expect(added?.message).toMatch(/EXPIRED/);
  });

  it("produces no other blocking findings", () => {
    expect(blocking(findings).every((item) => item.fieldPath === "premium.breakdown[].amount")).toBe(
      true,
    );
    expect(blocking(findings)).toHaveLength(2);
  });
});

describe("quote-api cascade: 2.1.0 compared against the last published 1.1.0", () => {
  it("still carries the amount→value rename against baseline 1.1.0 (D-4)", () => {
    const findings = diff("quote-api", "2-", "4-");
    expect(
      findings.find((item) => item.fieldPath === "premium.breakdown[].amount")?.code,
    ).toBe("ERR_BREAKING_FIELD_REMOVED");
    // The purely additive 2.1.0 fields are not breaking.
    expect(
      findings.filter((item) =>
        ["rider.ncbPercent", "premium.taxes"].includes(item.fieldPath ?? ""),
      ),
    ).toEqual([]);
  });

  it("additive request fields (optional) produce nothing", () => {
    const findings = diff("quote-api", "3-", "4-");
    expect(codesOf(findings)).toEqual([]);
  });
});

describe("policy-api: deprecations, removals and endorsement rules", () => {
  it("1.0.0 → 1.1.0 emits sunset notices only, no blocking findings", () => {
    const findings = diff("policy-api", "1-", "2-");
    // Both operations that return a Policy report each newly deprecated field
    // (the list endpoint uses the `[]` prefix for its array items).
    expect(new Set(codesOf(findings))).toEqual(new Set(["WARN_DEPRECATED_FIELD"]));
    expect(new Set(findings.map((item) => item.fieldPath))).toEqual(
      new Set(["holder.phone", "legacyCode", "[].holder.phone", "[].legacyCode"]),
    );
    expect(findings.find((item) => item.fieldPath === "legacyCode")?.message).toMatch(
      /2026-11-01/,
    );
    expect(findings.find((item) => item.fieldPath === "holder.phone")?.message).toMatch(
      /2027-06-30/,
    );
    expect(blocking(findings)).toEqual([]);
  });

  it("1.1.0 → 2.0.0 detects both removed fields, legacyCode as past-sunset hard-breaking", () => {
    const findings = diff("policy-api", "2-", "3-");
    const legacyCode = findings.find((item) => item.fieldPath === "legacyCode");
    expect(legacyCode?.code).toBe("ERR_SUNSET_REMOVAL_EXPIRED");
    expect(legacyCode?.severity).toBe("blocking");
    expect(legacyCode?.message).toMatch(/2026-11-01/);

    const phone = findings.find((item) => item.fieldPath === "holder.phone");
    expect(phone?.code).toBe("ERR_BREAKING_FIELD_REMOVED");
    expect(phone?.message).toMatch(/2027-06-30/);
  });

  it("1.1.0 → 2.1.0 (cascade baseline) detects required requestedBy and VEHICLE removal", () => {
    const findings = diff("policy-api", "2-", "4-");

    const requestedBy = findings.find((item) => item.fieldPath === "requestedBy");
    expect(requestedBy?.code).toBe("ERR_BREAKING_FIELD_NOW_REQUIRED");
    expect(requestedBy?.severity).toBe("blocking");
    expect(requestedBy?.operationRef).toBe("POST /policies/{policyId}/endorsements");

    const type = findings.find(
      (item) => item.code === "ERR_BREAKING_ENUM_VALUE_REMOVED" && item.fieldPath === "type",
    );
    expect(type?.severity).toBe("blocking");
    expect(type?.message).toMatch(/VEHICLE/);

    // Cascade: legacyCode is still absent versus the published baseline.
    expect(
      findings.find((item) => item.fieldPath === "legacyCode")?.code,
    ).toBe("ERR_SUNSET_REMOVAL_EXPIRED");
  });

  it("2.0.0 → 2.1.0 alone still shows requestedBy and VEHICLE against that baseline", () => {
    const findings = diff("policy-api", "3-", "4-");
    expect(codesOf(findings)).toEqual(
      expect.arrayContaining([
        "ERR_BREAKING_FIELD_NOW_REQUIRED",
        "ERR_BREAKING_ENUM_VALUE_REMOVED",
      ]),
    );
  });
});

describe("claims-api: amountApproved becomes optional", () => {
  it("1.0.0 → 2.0.0 flags the required drop while the field still exists", () => {
    const findings = diff("claims-api", "1-", "4-");
    const nowOptional = findings.filter((item) => item.code === "ERR_BREAKING_FIELD_NOW_OPTIONAL");
    // The Claim schema is returned by both POST (201) and GET (200).
    expect(nowOptional.length).toBeGreaterThanOrEqual(1);
    expect(new Set(nowOptional.map((item) => item.fieldPath))).toEqual(
      new Set(["amountApproved"]),
    );
    expect(nowOptional.every((item) => item.severity === "blocking")).toBe(true);

    // The field itself was not removed.
    expect(
      findings.find(
        (item) => item.code === "ERR_BREAKING_FIELD_REMOVED" && item.fieldPath === "amountApproved",
      ),
    ).toBeUndefined();
  });

  it("treats channel, assessorNotes and the 202 response as additive", () => {
    const findings = diff("claims-api", "1-", "4-");
    expect(
      findings.filter((item) => ["channel", "assessorNotes"].includes(item.fieldPath ?? "")),
    ).toEqual([]);
  });
});

describe("baseline selection (D-4)", () => {
  const versions = [
    { order: 1, status: "published", value: "1.0.0" },
    { order: 2, status: "published", value: "1.1.0" },
    { order: 3, status: "blocked", value: "2.0.0" },
    { order: 4, status: "pending", value: "2.1.0" },
  ];

  it("picks the last published version and skips blocked ones", () => {
    const baseline = selectBaseline(versions, versions[3] as (typeof versions)[number]);
    expect(baseline).toMatchObject({ kind: "previous" });
    if (baseline.kind === "previous") expect(baseline.version.value).toBe("1.1.0");
  });

  it("reports `first` when nothing earlier is published", () => {
    const pending = { order: 1, status: "pending", value: "1.0.0" };
    expect(selectBaseline([pending], pending)).toEqual({ kind: "first" });
    // A blocked earlier version is not a baseline either.
    const blocked = { order: 1, status: "blocked", value: "1.0.0" };
    expect(selectBaseline([blocked], pending)).toEqual({ kind: "first" });
  });

  it("diffAgainstBaseline walks around the blocked 2.0.0", () => {
    const result = diffAgainstBaseline(
      [
        { order: 1, status: "published", operations: specOf("quote-api", "1-").operations },
        { order: 2, status: "published", operations: specOf("quote-api", "2-").operations },
        { order: 3, status: "blocked", operations: specOf("quote-api", "3-").operations },
      ],
      { order: 4, status: "pending", operations: specOf("quote-api", "4-").operations },
      { asOfDate: AS_OF },
    );
    expect(result.baseline).toBe("previous");
    expect(
      result.findings.find((item) => item.fieldPath === "premium.breakdown[].amount")?.code,
    ).toBe("ERR_BREAKING_FIELD_REMOVED");
  });
});

describe("L-4 calendar-date semantics", () => {
  it("parses valid dates and rejects impossible ones", () => {
    expect(parseCalendarDate("2026-11-01")).toEqual(new Date(Date.UTC(2026, 10, 1)));
    expect(parseCalendarDate("2026-02-31")).toBeUndefined();
    expect(parseCalendarDate("1-11-2026")).toBeUndefined();
  });

  it("a sunset equal to the as-of date counts as due", () => {
    expect(sunsetExpired("2026-11-18", AS_OF)).toBe(true);
    expect(sunsetExpired("2026-11-17", AS_OF)).toBe(true);
    expect(sunsetExpired("2026-11-19", AS_OF)).toBe(false);
    expect(sunsetExpired("2027-06-30", AS_OF)).toBe(false);
  });

  it("an unparseable sunset never claims expiry", () => {
    expect(sunsetExpired("not-a-date", AS_OF)).toBe(false);
  });
});

describe("rulebook rules not planted in the kit (synthetic fixtures)", () => {
  function operationsOf(yamlText: string) {
    const parsed = parseYaml(yamlText);
    expect(parsed.ok).toBe(true);
    return indexOperations((parsed as { value: unknown }).value);
  }

  const BASE = `
openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /things/{id}:
    get:
      operationId: getThing
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [name, count]
                properties:
                  name: { type: string }
                  count: { type: integer }
                  kind: { type: string, enum: [A, B] }
`;

  function diffText(candidate: string): Finding[] {
    return diffWireIndexes(operationsOf(BASE), operationsOf(candidate), { asOfDate: AS_OF });
  }

  it("operation removed → ERR_BREAKING_OPERATION_REMOVED", () => {
    const removed = diffText(`
openapi: 3.0.3
info: { title: T, version: 2.0.0 }
paths: {}
`);
    // The whole operation is gone: one operation-level finding; its fields are
    // implicitly cut off and reported at the operation, not per field.
    expect(removed).toHaveLength(1);
    expect(codesOf(removed)).toEqual(["ERR_BREAKING_OPERATION_REMOVED"]);
    expect(removed[0]?.severity).toBe("blocking");
  });

  it("type change → ERR_BREAKING_TYPE_CHANGED", () => {
    const changed = diffText(BASE.replace("count: { type: integer }", "count: { type: string }"));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ code: "ERR_BREAKING_TYPE_CHANGED", fieldPath: "count" });
  });

  it("request field removed → ERR_BREAKING_FIELD_REMOVED", () => {
    const base = `
openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /things:
    post:
      operationId: makeThing
      responses: { '204': { description: ok } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [a, b]
              properties: { a: { type: string }, b: { type: string } }
`;
    const candidate = base.replace("required: [a, b]", "required: [a]").replace(/b: \{ type: string \}/, "c: { type: string }").replace("1.0.0", "2.0.0");
    const findings = diffWireIndexes(operationsOf(base), operationsOf(candidate), {
      asOfDate: AS_OF,
    });
    const removed = findings.find((item) => item.code === "ERR_BREAKING_FIELD_REMOVED");
    expect(removed).toMatchObject({ fieldPath: "b", severity: "blocking" });
  });

  it("request field made optional is safe (no finding)", () => {
    const base = `
openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /things:
    post:
      operationId: makeThing
      responses: { '204': { description: ok } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [a]
              properties: { a: { type: string } }
`;
    const relaxed = base.replace("required: [a]", "required: []").replace("1.0.0", "1.1.0");
    expect(diffWireIndexes(operationsOf(base), operationsOf(relaxed), { asOfDate: AS_OF })).toEqual(
      [],
    );
  });

  it("response enum shrink is not listed as breaking in the rulebook", () => {
    const findings = diffText(BASE.replace("kind: { type: string, enum: [A, B] }", "kind: { type: string, enum: [A] }"));
    expect(findings).toEqual([]);
  });

  it("new required request body field → ERR_BREAKING_FIELD_NOW_REQUIRED", () => {
    const base = `
openapi: 3.0.3
info: { title: T, version: 1.0.0 }
paths:
  /things:
    post:
      operationId: makeThing
      responses: { '204': { description: ok } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [a]
              properties: { a: { type: string } }
`;
    const grown = base
      .replace("required: [a]", "required: [a, extra]")
      .replace("properties: { a: { type: string } }", "properties: { a: { type: string }, extra: { type: string } }")
      .replace("1.0.0", "2.0.0");
    const findings = diffWireIndexes(operationsOf(base), operationsOf(grown), { asOfDate: AS_OF });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "ERR_BREAKING_FIELD_NOW_REQUIRED",
      fieldPath: "extra",
    });
  });

  it("path parameter rename with same shape is a zero-finding refactor", () => {
    const renamed = BASE.replace("name: id", "name: thingId").replace("/things/{id}", "/things/{thingId}").replace("1.0.0", "1.1.0");
    expect(diffWireIndexes(operationsOf(BASE), operationsOf(renamed), { asOfDate: AS_OF })).toEqual(
      [],
    );
  });
});
