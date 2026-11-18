import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  discoverConsumerFiles,
  discoverSpecFileList,
  discoverSpecFiles,
  publishOrderOf,
} from "../src/loader/discovery.js";

/** Repo root: contract-guard/test/ → ../../ */
const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("publishOrderOf", () => {
  it("reads the numeric filename prefix", () => {
    expect(publishOrderOf("1-initial.yaml")).toBe(1);
    expect(publishOrderOf("3-channel-and-notes-fixed.yaml")).toBe(3);
    expect(publishOrderOf("4-approval-later.yaml")).toBe(4);
  });

  it("sorts unprefixed names last", () => {
    expect(publishOrderOf("draft.yaml")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("discoverSpecFiles against the real kit", () => {
  it("finds 12 spec files across 3 services in numeric order per service", () => {
    const grouped = discoverSpecFiles(KIT_ROOT);
    expect([...grouped.keys()].sort()).toEqual(["claims-api", "policy-api", "quote-api"]);

    const expected: Record<string, string[]> = {
      "quote-api": [
        "1-initial.yaml",
        "2-reorganised.yaml",
        "3-price-lines.yaml",
        "4-ncb-and-taxes.yaml",
      ],
      "policy-api": [
        "1-initial.yaml",
        "2-deprecations.yaml",
        "3-remove-old-fields.yaml",
        "4-endorsement-rules.yaml",
      ],
      "claims-api": [
        "1-initial.yaml",
        "2-channel-and-notes.yaml",
        "3-channel-and-notes-fixed.yaml",
        "4-approval-later.yaml",
      ],
    };

    for (const [service, fileNames] of Object.entries(expected)) {
      const files = grouped.get(service);
      expect(files, `missing service ${service}`).toBeDefined();
      expect(files?.map((file) => file.fileName)).toEqual(fileNames);
      expect(files?.map((file) => file.order)).toEqual([1, 2, 3, 4]);
    }

    expect(discoverSpecFileList(KIT_ROOT)).toHaveLength(12);
  });

  it("uses the folder name as the service identity that consumers reference", () => {
    for (const file of discoverSpecFileList(KIT_ROOT)) {
      expect(file.service).toBe(file.relativePath.split("/")[1]);
      expect(file.absolutePath.endsWith(file.relativePath)).toBe(true);
    }
  });
});

describe("discoverConsumerFiles against the real kit", () => {
  it("finds all four consumer manifests", () => {
    const consumers = discoverConsumerFiles(KIT_ROOT);
    expect(consumers.map((consumer) => consumer.name)).toEqual([
      "mobile-app",
      "notifications-svc",
      "partner-portal",
      "payments-svc",
    ]);
    for (const consumer of consumers) {
      expect(consumer.relativePath).toBe(`consumers/${consumer.fileName}`);
    }
  });
});
