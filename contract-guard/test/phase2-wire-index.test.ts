import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db/database.js";
import { indexKit, findIndexedSpec, type KitIndexResult } from "../src/pipeline/indexKit.js";
import { comparableIndex } from "../src/wire/operationIndex.js";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const dirs: string[] = [];
const handles: Array<Database> = [];
// The indexed kit is built once per file, so cleanup runs after the last test.
afterAll(() => {
  while (handles.length) handles.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

let cached: { db: Database; index: KitIndexResult } | undefined;
function indexed(): { db: Database; index: KitIndexResult } {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "cg-wire-"));
  dirs.push(dir);
  const { db } = openDatabase({ path: join(dir, "cg.db") });
  handles.push(db);
  cached = { db, index: indexKit(KIT_ROOT, db) };
  return cached;
}

function fieldsOf(index: KitIndexResult, service: string, prefix: string, method: string, pathFragment: string) {
  const spec = findIndexedSpec(index, service, prefix);
  const operation = spec?.operations.find(
    (op) => op.method === method && op.pathTemplate.includes(pathFragment),
  );
  return { spec, operation };
}

describe("quote-api 1.0.0 and 1.1.0 produce equivalent wire indexes", () => {
  it("comparable index is byte-identical across the refactor", () => {
    const { index } = indexed();
    const before = findIndexedSpec(index, "quote-api", "1-");
    const after = findIndexedSpec(index, "quote-api", "2-");

    expect(before?.version).toBe("1.0.0");
    expect(after?.version).toBe("1.1.0");
    expect(comparableIndex(after?.operations ?? [])).toEqual(comparableIndex(before?.operations ?? []));
  });

  it("component renames and inlined objects change nothing on the wire", () => {
    const { index } = indexed();
    const before = findIndexedSpec(index, "quote-api", "1-");
    const after = findIndexedSpec(index, "quote-api", "2-");

    const paths = (spec?: { operations: Array<{ pathTemplate: string }> }) =>
      (spec?.operations ?? []).map((op) => `${op.method} ${op.normalizedPath}`).sort();
    expect(paths(after)).toEqual(paths(before));
    expect(paths(after)).toEqual([
      "DELETE /internal/pricing-cache",
      "GET /quotes/{}",
      "POST /quotes",
    ]);
  });
});

describe("field paths resolve in consumer notation", () => {
  it("resolves premium.breakdown[].amount from a $ref chain in 1.0.0 and 1.1.0", () => {
    const { index } = indexed();
    for (const prefix of ["1-", "2-"]) {
      const { operation } = fieldsOf(index, "quote-api", prefix, "POST", "/quotes");
      const amount = operation?.requestFields.concat(operation.responseFieldsByStatus.flatMap((g) => g.fields));
      const found = amount?.find((field) => field.path === "premium.breakdown[].amount");
      expect(found, `missing premium.breakdown[].amount in ${prefix}`).toMatchObject({
        direction: "response",
        statusCode: "201",
        type: "number",
        required: true,
      });
      // The array container and its item node are both indexed.
      expect(amount?.map((field) => field.path)).toEqual(
        expect.arrayContaining(["premium", "premium.breakdown", "premium.breakdown[]"]),
      );
    }
  });

  it("in 2.0.0 the same slot is renamed to value", () => {
    const { index } = indexed();
    const { operation } = fieldsOf(index, "quote-api", "3-", "POST", "/quotes");
    const paths = operation?.responseFieldsByStatus
      .flatMap((group) => group.fields)
      .map((field) => field.path);
    expect(paths).toContain("premium.breakdown[].value");
    expect(paths).not.toContain("premium.breakdown[].amount");
  });

  it("indexes request body fields with requiredness", () => {
    const { index } = indexed();
    const { operation } = fieldsOf(index, "quote-api", "1-", "POST", "/quotes");
    const request = new Map(operation?.requestFields.map((field) => [field.path, field]));

    expect(request.get("vehicle")).toMatchObject({ required: true, type: "object" });
    expect(request.get("vehicle.make")).toMatchObject({ required: true, type: "string" });
    expect(request.get("vehicle.model")).toMatchObject({ required: false, type: "string" });
    expect(request.get("vehicle.cc")).toMatchObject({ required: true, type: "integer" });
    expect(request.get("rider.age")).toMatchObject({ required: true, type: "integer" });
    expect(request.get("rider.city")).toMatchObject({ required: false, type: "string" });
    // 4-ncb-and-taxes adds an optional bounded field.
    const later = fieldsOf(index, "quote-api", "4-", "POST", "/quotes").operation;
    const ncb = later?.requestFields.find((field) => field.path === "rider.ncbPercent");
    expect(ncb).toMatchObject({ required: false, type: "integer" });
    const taxes = later?.responseFieldsByStatus
      .flatMap((group) => group.fields)
      .find((field) => field.path === "premium.taxes");
    expect(taxes).toMatchObject({ required: false, type: "number" });
  });

  it("indexes path and query parameters as request fields", () => {
    const { index } = indexed();
    const original = fieldsOf(index, "quote-api", "1-", "GET", "quotes");
    expect(original.operation?.parameters).toEqual([
      { name: "id", in: "path", required: true, type: "string" },
    ]);
    expect(original.operation?.requestFields.map((field) => field.path)).toEqual(["id"]);

    const renamed = fieldsOf(index, "quote-api", "2-", "GET", "quotes");
    expect(renamed.operation?.parameters).toEqual([
      { name: "quoteId", in: "path", required: true, type: "string" },
    ]);

    // Policy search has an optional query parameter.
    const search = fieldsOf(index, "policy-api", "1-", "GET", "/policies");
    expect(search.operation?.requestFields.map((field) => field.path)).toEqual(["holder"]);
    expect(search.operation?.requestFields[0]).toMatchObject({ required: false, type: "string" });

    // The internal pricing-cache operation gains a required region parameter in 2.0.0.
    const cache = fieldsOf(index, "quote-api", "3-", "DELETE", "pricing-cache");
    expect(cache.operation?.requestFields[0]).toMatchObject({
      path: "region",
      required: true,
      type: "string",
    });
  });

  it("indexes enums, deprecation markers and x-sunset dates", () => {
    const { index } = indexed();

    const quoteStatus = fieldsOf(index, "quote-api", "1-", "POST", "/quotes").operation
      ?.responseFieldsByStatus.flatMap((g) => g.fields)
      .find((field) => field.path === "status");
    expect(quoteStatus?.enumValues).toEqual(["DRAFT", "FINAL"]);
    const laterStatus = findIndexedSpec(index, "quote-api", "3-")?.operations
      .find((op) => op.method === "POST")
      ?.responseFieldsByStatus.flatMap((g) => g.fields)
      .find((field) => field.path === "status");
    expect(laterStatus?.enumValues).toEqual(["DRAFT", "FINAL", "EXPIRED"]);

    const deprecated = fieldsOf(index, "policy-api", "2-", "GET", "/policies/{policyId}");
    const responseFields = deprecated.operation?.responseFieldsByStatus.flatMap((g) => g.fields) ?? [];
    const legacyCode = responseFields.find((field) => field.path === "legacyCode");
    expect(legacyCode).toMatchObject({ deprecated: true, sunsetDate: "2026-11-01", required: false });
    const phone = responseFields.find((field) => field.path === "holder.phone");
    expect(phone).toMatchObject({ deprecated: true, sunsetDate: "2027-06-30" });

    // 1.0.0 has the same fields without the markers.
    const initial = fieldsOf(index, "policy-api", "1-", "GET", "/policies/{policyId}");
    const initialLegacy = initial.operation?.responseFieldsByStatus
      .flatMap((g) => g.fields)
      .find((field) => field.path === "legacyCode");
    expect(initialLegacy).toMatchObject({ deprecated: false, sunsetDate: null });

    const endorsementType = fieldsOf(index, "policy-api", "4-", "POST", "endorsements").operation
      ?.requestFields.find((field) => field.path === "type");
    expect(endorsementType?.enumValues).toEqual(["ADDRESS", "NOMINEE"]);
    expect(endorsementType?.required).toBe(true);
    expect(
      fieldsOf(index, "policy-api", "4-", "POST", "endorsements").operation?.requestFields,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: "requestedBy", required: true })]));
  });

  it("marks x-internal operations and flattens root-level array responses", () => {
    const { index } = indexed();

    const cache = findIndexedSpec(index, "quote-api", "1-")?.operations.find(
      (op) => op.pathTemplate === "/internal/pricing-cache",
    );
    expect(cache?.isInternal).toBe(true);
    const publicOps = findIndexedSpec(index, "quote-api", "1-")?.operations.filter(
      (op) => op.pathTemplate !== "/internal/pricing-cache",
    );
    expect(publicOps?.every((op) => op.isInternal === false)).toBe(true);

    // GET /policies returns an array root: children are addressed as [].field
    const search = fieldsOf(index, "policy-api", "1-", "GET", "/policies");
    const paths = search.operation?.responseFieldsByStatus.flatMap((g) => g.fields).map((f) => f.path);
    expect(paths).toContain("[].policyId");
    expect(paths).toContain("[].premiumDue.amount");
    expect(paths).not.toContain("");
  });
});

describe("the broken claims-api reference does not break indexing", () => {
  it("indexes what it can and records the unresolvable node opaquely", () => {
    const { index } = indexed();
    const broken = findIndexedSpec(index, "claims-api", "2-");
    expect(broken).toBeDefined();

    const submit = broken?.operations.find((op) => op.method === "POST");
    const documents = submit?.responseFieldsByStatus
      .flatMap((group) => group.fields)
      .find((field) => field.path === "documents[]");
    // Unresolvable component: recorded with a null type instead of crashing.
    expect(documents).toMatchObject({ type: null });

    const fixed = findIndexedSpec(index, "claims-api", "3-");
    const fixedDocuments = fixed?.operations
      .find((op) => op.method === "POST")
      ?.responseFieldsByStatus.flatMap((group) => group.fields)
      .find((field) => field.path === "documents[].docId");
    expect(fixedDocuments).toMatchObject({ type: "string", required: true });
  });

  it("keeps amountApproved indexed when it stops being required in 2.0.0", () => {
    const { index } = indexed();
    for (const [prefix, required] of [
      ["3-", true],
      ["4-", false],
    ] as const) {
      const field = findIndexedSpec(index, "claims-api", prefix)
        ?.operations.find((op) => op.method === "GET")
        ?.responseFieldsByStatus.flatMap((g) => g.fields)
        .find((candidate) => candidate.path === "amountApproved");
      expect(field, `amountApproved in ${prefix}`).toMatchObject({ type: "integer", required });
    }
  });
});

describe("the wire index is persisted", () => {
  it("writes operations and fields for all 12 versions, idempotently", () => {
    const { db, index } = indexed();

    expect(index.specs).toHaveLength(12);
    const operations = (db.prepare("SELECT COUNT(*) AS n FROM operations").get() as { n: number }).n;
    const fields = (db.prepare("SELECT COUNT(*) AS n FROM wire_fields").get() as { n: number }).n;
    expect(operations).toBe(index.totals.operations);
    expect(fields).toBe(index.totals.fields);
    expect(operations).toBeGreaterThan(0);
    expect(fields).toBeGreaterThan(operations);

    // All four quote-api versions carry the x-internal pricing-cache operation.
    const internal = (
      db.prepare("SELECT COUNT(*) AS n FROM operations WHERE is_internal = 1").get() as { n: number }
    ).n;
    expect(internal).toBe(4);

    // Re-indexing replaces rather than duplicates.
    const again = indexKit(KIT_ROOT, db);
    expect(again.totals).toEqual(index.totals);
    expect((db.prepare("SELECT COUNT(*) AS n FROM operations").get() as { n: number }).n).toBe(operations);
    expect((db.prepare("SELECT COUNT(*) AS n FROM wire_fields").get() as { n: number }).n).toBe(fields);
  });

  it("stores enum values, sunset dates and required flags in their columns", () => {
    const { db } = indexed();
    const row = db
      .prepare(
        `SELECT wf.required, wf.enum_values, wf.deprecated, wf.sunset_date
         FROM wire_fields wf
         JOIN operations o ON o.id = wf.operation_id
         JOIN spec_versions sv ON sv.id = o.spec_version_id
         JOIN services s ON s.id = sv.service_id
         WHERE s.name = 'policy-api' AND sv.version = '1.1.0' AND wf.field_path = 'legacyCode'`,
      )
      .get() as { required: number; enum_values: string | null; deprecated: number; sunset_date: string };
    expect(row).toMatchObject({ required: 0, deprecated: 1, sunset_date: "2026-11-01" });

    const quoteStatus = db
      .prepare(
        `SELECT wf.enum_values FROM wire_fields wf
         JOIN operations o ON o.id = wf.operation_id
         JOIN spec_versions sv ON sv.id = o.spec_version_id
         JOIN services s ON s.id = sv.service_id
         WHERE s.name = 'quote-api' AND sv.version = '2.0.0' AND wf.field_path = 'status'`,
      )
      .get() as { enum_values: string };
    expect(JSON.parse(quoteStatus.enum_values)).toEqual(["DRAFT", "FINAL", "EXPIRED"]);
  });
});
