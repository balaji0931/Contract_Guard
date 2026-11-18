import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db/database.js";
import { indexKit, findIndexedSpec, type KitIndexResult } from "../src/pipeline/indexKit.js";
import { diffWireIndexes } from "../src/diff/wireDiff.js";
import {
  attributeConsumerImpacts,
  groupImpactsByConsumer,
  type ConsumerImpact,
} from "../src/impact/consumerImpact.js";
import { finding, type Finding } from "../src/findings/codes.js";
import type { ConsumerUseIndex } from "../src/consumers/consumerIndex.js";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
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
  const dir = mkdtempSync(join(tmpdir(), "cg-impact-"));
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

function impactsFor(service: string, basePrefix: string, candPrefix: string): ConsumerImpact[] {
  const baseline = specOf(service, basePrefix);
  const candidate = specOf(service, candPrefix);
  const findings = diffWireIndexes(baseline.operations, candidate.operations, {
    asOfDate: AS_OF,
  });
  return attributeConsumerImpacts({
    service,
    findings,
    baselineOperations: baseline.operations,
    candidateOperations: candidate.operations,
    consumerIndex: indexed().consumers,
  });
}

function consumersWithIssues(impacts: ConsumerImpact[]): string[] {
  return [...new Set(impacts.map((impact) => impact.consumer))].sort();
}

describe("mobile-app: quote premium.breakdown[].amount (matrix row 3)", () => {
  const impacts = impactsFor("quote-api", "2-", "3-");

  it("attributes the amount removal to mobile-app on POST /quotes", () => {
    const mobile = impacts.filter((impact) => impact.consumer === "mobile-app");
    expect(mobile).toHaveLength(1);
    expect(mobile[0]).toMatchObject({
      code: "ERR_BREAKING_FIELD_REMOVED",
      severity: "blocking",
      direction: "reads",
      fieldPath: "premium.breakdown[].amount",
      operationRef: "POST /quotes",
      team: "Mobile",
    });
    expect(mobile[0]?.message).toContain("mobile-app");
  });

  it("does not expose partner-portal or notifications-svc, which never read amount", () => {
    expect(consumersWithIssues(impacts)).toEqual(["mobile-app"]);
  });

  it("reports no consumer impact on the internal pricing-cache op (PO-1/L-1)", () => {
    expect(impacts.filter((impact) => impact.operationRef.includes("pricing-cache"))).toEqual([]);
  });

  it("the EXPIRED enum warning creates no consumer impact", () => {
    expect(impacts.filter((impact) => impact.code === "WARN_ENUM_VALUE_ADDED")).toEqual([]);
  });
});

describe("mobile-app: claims amountApproved becoming optional (matrix row 12)", () => {
  const impacts = impactsFor("claims-api", "1-", "4-");

  it("attributes the required-drop to mobile-app on GET /claims/{claimId}", () => {
    const mobile = impacts.filter((impact) => impact.consumer === "mobile-app");
    expect(mobile).toHaveLength(1);
    expect(mobile[0]).toMatchObject({
      code: "ERR_BREAKING_FIELD_NOW_OPTIONAL",
      direction: "reads",
      fieldPath: "amountApproved",
      operationRef: "GET /claims/{claimId}",
    });
  });

  it("notifications-svc, which reads only claimId and status, is not exposed", () => {
    expect(consumersWithIssues(impacts)).toEqual(["mobile-app"]);
  });
});

describe("payments-svc: legacyCode sunset removal (matrix rows 6–7)", () => {
  const impacts = impactsFor("policy-api", "2-", "3-");

  it("attributes the past-sunset removal to payments-svc", () => {
    const payments = impacts.filter((impact) => impact.consumer === "payments-svc");
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      code: "ERR_SUNSET_REMOVAL_EXPIRED",
      severity: "blocking",
      direction: "reads",
      fieldPath: "legacyCode",
      operationRef: "GET /policies/{policyId}",
      team: "Payments",
    });
  });

  it("holder.phone removal exposes nobody — no manifest reads it", () => {
    expect(impacts.filter((impact) => impact.fieldPath === "holder.phone")).toEqual([]);
    expect(consumersWithIssues(impacts)).toEqual(["payments-svc"]);
  });
});

describe("partner-portal: requestedBy and the VEHICLE enum drop (matrix row 8)", () => {
  const impacts = impactsFor("policy-api", "2-", "4-");

  it("breaks partner-portal for the new required requestedBy it does not send", () => {
    const requestedBy = impacts.find(
      (impact) =>
        impact.consumer === "partner-portal" && impact.fieldPath === "requestedBy",
    );
    expect(requestedBy).toMatchObject({
      code: "ERR_BREAKING_FIELD_NOW_REQUIRED",
      direction: "sends",
      possibleUsage: false,
    });
    expect(requestedBy?.message).toMatch(/does not send the newly required `requestedBy`/);
  });

  it("reports the VEHICLE enum removal on the sent `type` field as possible-usage (L-5)", () => {
    const enumImpact = impacts.find(
      (impact) =>
        impact.consumer === "partner-portal" &&
        impact.code === "ERR_BREAKING_ENUM_VALUE_REMOVED",
    );
    expect(enumImpact).toMatchObject({
      direction: "sends",
      fieldPath: "type",
      possibleUsage: true,
      severity: "blocking",
    });
    expect(enumImpact?.message).toMatch(/VEHICLE/);
    expect(enumImpact?.message).toMatch(/possible-usage match/);
  });

  it("payments-svc is still exposed on legacyCode through the cascade", () => {
    expect(
      impacts.find((i) => i.consumer === "payments-svc" && i.code === "ERR_SUNSET_REMOVAL_EXPIRED"),
    ).toBeDefined();
  });

  it("notifications-svc, which uses no changed operation, stays clean", () => {
    expect(impacts.filter((impact) => impact.consumer === "notifications-svc")).toEqual([]);
  });
});

describe("alias-correct matching (D-3)", () => {
  it("mobile-app's `id` sends still resolve after the quoteId rename", () => {
    // The quote 1.1.0→2.0.0 diff made no change to the renamed path param;
    // a hypothetical required-param finding on `quoteId` must NOT expose the
    // manifest that sends `id` — the alias map rewrites it to `quoteId`.
    const baseline = specOf("quote-api", "2-");
    const candidate = specOf("quote-api", "3-");
    const impacts = attributeConsumerImpacts({
      service: "quote-api",
      findings: [
        finding("ERR_BREAKING_FIELD_NOW_REQUIRED", "request field `quoteId` is now required", {
          operationRef: "GET /quotes/{quoteId}",
          fieldPath: "quoteId",
        }),
      ],
      baselineOperations: baseline.operations,
      candidateOperations: candidate.operations,
      consumerIndex: indexed().consumers,
    });
    // mobile-app and notifications-svc both send the param (as `id`) → unaffected.
    expect(impacts).toEqual([]);
  });
});

describe("internal-endpoint exclusion proven directly (PO-1/L-1)", () => {
  it("skips consumer impact even for a synthetic consumer calling the internal op", () => {
    const internalUser: ConsumerUseIndex = {
      useId: 999,
      consumer: "cache-buster",
      team: "Infra",
      provider: "quote-api",
      method: "DELETE",
      pathTemplate: "/internal/pricing-cache",
      normalizedPath: "/internal/pricing-cache",
      sends: ["region"],
      reads: [],
    };
    // A BLOCKING finding on the internal op (diff downgrades these to notes;
    // the engine must exclude them again regardless).
    const impacts = attributeConsumerImpacts({
      service: "quote-api",
      findings: [
        finding("ERR_BREAKING_FIELD_NOW_REQUIRED", "request field `region` is new and required", {
          operationRef: "DELETE /internal/pricing-cache",
          fieldPath: "region",
        }),
      ],
      baselineOperations: specOf("quote-api", "2-").operations,
      candidateOperations: specOf("quote-api", "3-").operations,
      consumerIndex: [...indexed().consumers, internalUser],
    });
    expect(impacts).toEqual([]);
  });
});

describe("operation removal exposes every caller (rulebook)", () => {
  it("attributes a removed operation to both quote readers", () => {
    const impacts = attributeConsumerImpacts({
      service: "quote-api",
      findings: [
        finding("ERR_BREAKING_OPERATION_REMOVED", "operation GET /quotes/{} was removed", {
          operationRef: "GET /quotes/{}",
        }),
      ],
      baselineOperations: specOf("quote-api", "1-").operations,
      candidateOperations: specOf("quote-api", "2-").operations,
      consumerIndex: indexed().consumers,
    });
    expect(consumersWithIssues(impacts)).toEqual(["mobile-app", "notifications-svc"]);
    expect(impacts[0]?.message).toMatch(/calls GET \/quotes\/\{\}, which no longer exists/);
  });
});

describe("consumers that send a new required field are NOT exposed", () => {
  it("skips manifests that already send the field", () => {
    const impacts = attributeConsumerImpacts({
      service: "quote-api",
      findings: [
        finding("ERR_BREAKING_FIELD_NOW_REQUIRED", "request field `vehicle.make` is now required", {
          operationRef: "POST /quotes",
          fieldPath: "vehicle.make",
        }),
      ],
      baselineOperations: specOf("quote-api", "1-").operations,
      candidateOperations: specOf("quote-api", "2-").operations,
      consumerIndex: indexed().consumers,
    });
    // mobile-app and partner-portal both send vehicle.make.
    expect(impacts).toEqual([]);
  });
});

describe("exposed-consumer grouping (PLAN §7 view)", () => {
  it("lists every consumer, with issue counts, notifications-svc clean", () => {
    const quoteImpacts = impactsFor("quote-api", "2-", "3-");
    const claimsImpacts = impactsFor("claims-api", "1-", "4-");
    const all = [...quoteImpacts, ...claimsImpacts];
    const grouped = groupImpactsByConsumer(all, indexed().consumers);

    expect(grouped.map((group) => [group.consumer, group.issues.length])).toEqual([
      ["mobile-app", 2],
      ["notifications-svc", 0],
      ["partner-portal", 0],
      ["payments-svc", 0],
    ]);
    expect(grouped.find((group) => group.consumer === "mobile-app")?.team).toBe("Mobile");
  });
});
