import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db/database.js";
import { indexKit, findIndexedSpec, type KitIndexResult } from "../src/pipeline/indexKit.js";
import {
  findOperationForUse,
  loadConsumerIndex,
  matchesOperation,
  resolveUse,
  type ConsumerUseIndex,
} from "../src/consumers/consumerIndex.js";
import { applyParamAlias, buildParamAliasMap, templateParams } from "../src/wire/aliases.js";

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
  const dir = mkdtempSync(join(tmpdir(), "cg-consumers-"));
  dirs.push(dir);
  const { db } = openDatabase({ path: join(dir, "cg.db") });
  handles.push(db);
  cached = { db, index: indexKit(KIT_ROOT, db) };
  return cached;
}

function useOf(index: KitIndexResult, consumer: string, matcher: (use: ConsumerUseIndex) => boolean) {
  return index.consumers.find((use) => use.consumer === consumer && matcher(use));
}

describe("parameter alias primitives", () => {
  it("extracts template parameters in order", () => {
    expect(templateParams("/quotes/{id}")).toEqual(["id"]);
    expect(templateParams("/policies/{policyId}/endorsements")).toEqual(["policyId"]);
    expect(templateParams("/quotes")).toEqual([]);
  });

  it("builds positional rename maps", () => {
    expect(buildParamAliasMap("/quotes/{id}", "/quotes/{quoteId}")).toEqual({ id: "quoteId" });
    expect(buildParamAliasMap("/quotes/{id}", "/quotes/{id}")).toEqual({});
    // Different wire shapes yield no alias rather than a bogus one.
    expect(buildParamAliasMap("/a/{x}/b/{y}", "/a/{x}")).toEqual({});
  });

  it("rewrites only the parameter segment of a field path", () => {
    const aliases = { id: "quoteId" };
    expect(applyParamAlias("id", aliases)).toBe("quoteId");
    expect(applyParamAlias("premium.total", aliases)).toBe("premium.total");
    expect(applyParamAlias("id.items[]", aliases)).toBe("quoteId.items[]");
    expect(applyParamAlias("vehicle.make", {})).toBe("vehicle.make");
  });
});

describe("/quotes/{id} matches /quotes/{quoteId}", () => {
  it("a manifest written against the old name resolves against the renamed operation", () => {
    const { index } = indexed();
    const use = useOf(index, "mobile-app", (candidate) => candidate.provider === "quote-api" && candidate.method === "GET");
    expect(use?.pathTemplate).toBe("/quotes/{id}");
    expect(use?.normalizedPath).toBe("/quotes/{}");

    const renamed = findIndexedSpec(index, "quote-api", "2-");
    const resolved = resolveUse(use as ConsumerUseIndex, renamed?.operations ?? []);

    expect(resolved.operation?.pathTemplate).toBe("/quotes/{quoteId}");
    expect(resolved.aliasMap).toEqual({ id: "quoteId" });
    expect(resolved.use.sends).toEqual(["id"]);
    expect(resolved.resolvedSends).toEqual(["quoteId"]);

    // The renamed parameter really is the operation's request field.
    expect(resolved.operation?.requestFields.map((field) => field.path)).toEqual(["quoteId"]);
  });

  it("matching ignores parameter names entirely", () => {
    const { index } = indexed();
    const use = useOf(index, "notifications-svc", (candidate) => candidate.provider === "quote-api");
    for (const prefix of ["1-", "2-", "3-", "4-"]) {
      const spec = findIndexedSpec(index, "quote-api", prefix);
      expect(
        findOperationForUse(
          { method: "GET", normalizedPath: "/quotes/{}" },
          spec?.operations ?? [],
        )?.method,
      ).toBe("GET");
      expect(use?.normalizedPath).toBe("/quotes/{}");
    }
  });

  it("a non-matching path resolves to no operation", () => {
    const { index } = indexed();
    const quoteOps = findIndexedSpec(index, "quote-api", "1-")?.operations ?? [];
    expect(
      findOperationForUse({ method: "GET", normalizedPath: "/policies/{}" }, quoteOps),
    ).toBeUndefined();
    expect(matchesOperation({ method: "POST", normalizedPath: "/quotes" }, quoteOps[1])).toBe(false);
  });
});

describe("all four consumers are indexed and resolve against the kit", () => {
  it("every manifest entry addresses an operation in the first version of its provider", () => {
    const { index } = indexed();
    expect(index.consumers).toHaveLength(10);
    expect(new Set(index.consumers.map((use) => use.consumer))).toEqual(
      new Set(["mobile-app", "notifications-svc", "partner-portal", "payments-svc"]),
    );

    const firstVersions = new Map<string, NonNullable<ReturnType<typeof findIndexedSpec>>>();
    for (const service of ["quote-api", "policy-api", "claims-api"]) {
      const spec = findIndexedSpec(index, service, "1-");
      expect(spec, `missing first version of ${service}`).toBeDefined();
      firstVersions.set(service, spec as never);
    }

    const unmatched: string[] = [];
    for (const use of index.consumers) {
      const operations = firstVersions.get(use.provider)?.operations ?? [];
      const resolved = resolveUse(use, operations);
      if (resolved.operation === undefined) {
        unmatched.push(`${use.consumer} ${use.method} ${use.pathTemplate} → ${use.provider}`);
      }
    }
    expect(unmatched).toEqual([]);
  });

  it("carries normalized paths and field lists for every use", () => {
    const { index } = indexed();
    const byConsumer = new Map<string, ConsumerUseIndex[]>();
    for (const use of index.consumers) {
      const bucket = byConsumer.get(use.consumer) ?? [];
      bucket.push(use);
      byConsumer.set(use.consumer, bucket);
    }

    expect(byConsumer.get("mobile-app")).toHaveLength(4);
    expect(byConsumer.get("partner-portal")).toHaveLength(2);
    expect(byConsumer.get("payments-svc")).toHaveLength(1);
    expect(byConsumer.get("notifications-svc")).toHaveLength(3);

    for (const use of index.consumers) {
      expect(use.normalizedPath).toBe(use.pathTemplate.replace(/\{[^}]*\}/g, "{}"));
      expect(use.sends.length + use.reads.length).toBeGreaterThan(0);
      expect(use.team).toBeTruthy();
    }

    const endorsement = useOf(index, "partner-portal", (use) => use.pathTemplate.includes("endorsements"));
    expect(endorsement?.normalizedPath).toBe("/policies/{}/endorsements");
    expect(endorsement?.sends).toEqual(["policyId", "type", "details"]);

    const payments = useOf(index, "payments-svc", (use) => use.provider === "policy-api");
    expect(payments?.reads).toContain("legacyCode");

    const mobileClaims = useOf(index, "mobile-app", (use) => use.provider === "claims-api" && use.method === "GET");
    expect(mobileClaims?.reads).toEqual(["claimId", "status", "amountApproved"]);
  });

  it("reads the index straight from the persisted tables", () => {
    const { db, index } = indexed();
    const reloaded = loadConsumerIndex(db);
    expect(reloaded).toEqual(index.consumers);
  });
});
