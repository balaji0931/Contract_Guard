import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { loadSpecFile } from "../src/loader/specLoader.js";
import { collectReferences, resolveLocalPointer, validateSpec } from "../src/validator/specValidator.js";
import { parseYaml } from "../src/loader/readFile.js";
import type { SpecFileRef } from "../src/loader/discovery.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Fixtures live in a temp directory: the kit's specs/ folder is never written. */
function fixtureRef(yamlText: string, fileName = "1-fixture.yaml"): SpecFileRef {
  const dir = mkdtempSync(join(tmpdir(), "cg-spec-fixture-"));
  dirs.push(dir);
  const absolutePath = join(dir, fileName);
  writeFileSync(absolutePath, yamlText, "utf8");
  return {
    service: "fixture-api",
    order: 1,
    fileName,
    relativePath: `fixtures/${fileName}`,
    absolutePath,
  };
}

const VALID_SPEC = `
openapi: 3.0.3
info:
  title: Fixture API
  version: 1.0.0
  description: 'Fixtures. Owner: Fixture team.'
paths:
  /things:
    get:
      operationId: listThings
      responses:
        '200':
          description: list
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Thing'
components:
  schemas:
    Thing:
      type: object
      required: [id]
      properties:
        id:
          type: string
`;

describe("validateSpec on a sound document", () => {
  it("reports no issues", () => {
    const parsed = parseYaml(VALID_SPEC);
    expect(parsed.ok).toBe(true);
    expect(validateSpec(parsed.value)).toEqual([]);
  });

  it("collects internal references and resolves them", () => {
    const parsed = parseYaml(VALID_SPEC) as { value: unknown };
    const references = collectReferences(parsed.value);
    expect(references).toHaveLength(1);
    expect(references[0]?.ref).toBe("#/components/schemas/Thing");
    expect(resolveLocalPointer(parsed.value, "#/components/schemas/Thing").ok).toBe(true);
    expect(resolveLocalPointer(parsed.value, "#/components/schemas/Nope").ok).toBe(false);
  });
});

describe("validateSpec rejects broken documents", () => {
  it("flags a dangling $ref by name", () => {
    const yamlText = VALID_SPEC.replace(
      "$ref: '#/components/schemas/Thing'",
      "$ref: '#/components/schemas/Thinggg'",
    );
    const intake = loadSpecFile(fixtureRef(yamlText));
    expect(intake.valid).toBe(false);
    expect(intake.issues.map((issue) => issue.code)).toContain("ERR_INVALID_SPEC");
    expect(intake.issues[0]?.message).toMatch(/unresolved \$ref "#\/components\/schemas\/Thinggg"/);
    expect(intake.issues[0]?.severity).toBe("blocking");
    // Metadata is still recorded so the version can be reserved (L-2).
    expect(intake.version).toBe("1.0.0");
  });

  it("flags an external $ref, which the kit never uses", () => {
    const yamlText = VALID_SPEC.replace(
      "$ref: '#/components/schemas/Thing'",
      "$ref: 'other-file.yaml#/components/schemas/Thing'",
    );
    const issues = validateSpec((parseYaml(yamlText) as { value: unknown }).value);
    expect(issues.map((issue) => issue.message).join(" ")).toMatch(/external \$ref/);
  });

  it("flags duplicate operationIds", () => {
    const yamlText = `
openapi: 3.0.3
info: { title: Fixture, version: 1.0.0 }
paths:
  /a:
    get:
      operationId: sameName
      responses: { '204': { description: ok } }
  /b:
    get:
      operationId: sameName
      responses: { '204': { description: ok } }
`;
    const issues = validateSpec((parseYaml(yamlText) as { value: unknown }).value);
    expect(issues.map((issue) => issue.message).join(" ")).toMatch(
      /operationId "sameName" is declared 2 times/,
    );
  });

  it("flags two path templates that collide once parameters are normalized", () => {
    const yamlText = `
openapi: 3.0.3
info: { title: Fixture, version: 1.0.0 }
paths:
  /things/{id}:
    get:
      operationId: getOne
      responses: { '204': { description: ok } }
  /things/{thingId}:
    get:
      operationId: getOther
      responses: { '204': { description: ok } }
`;
    const issues = validateSpec((parseYaml(yamlText) as { value: unknown }).value);
    expect(issues.map((issue) => issue.message).join(" ")).toMatch(/GET \/things\/\{\} is declared more than once/);
  });

  it("flags a missing info.version", () => {
    const yamlText = `
openapi: 3.0.3
info: { title: Fixture }
paths:
  /a:
    get: { operationId: a, responses: { '204': { description: ok } } }
`;
    const issues = validateSpec((parseYaml(yamlText) as { value: unknown }).value);
    expect(issues.map((issue) => issue.message)).toContain("spec has no usable `info.version`");
  });

  it("flags a spec with no operations", () => {
    const yamlText = `
openapi: 3.0.3
info: { title: Fixture, version: 1.0.0 }
paths: {}
`;
    const issues = validateSpec((parseYaml(yamlText) as { value: unknown }).value);
    expect(issues.map((issue) => issue.message)).toContain("spec declares no operations under `paths`");
  });
});

describe("loadSpecFile never throws on malformed input", () => {
  it("handles unparseable YAML", () => {
    const intake = loadSpecFile(fixtureRef("openapi: 3.0.3\ninfo: [unclosed\n"));
    expect(intake.valid).toBe(false);
    expect(intake.issues[0]?.code).toBe("ERR_INVALID_SPEC");
    expect(intake.issues[0]?.message).toMatch(/YAML parse error/);
    expect(intake.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles a document that is not a mapping", () => {
    const intake = loadSpecFile(fixtureRef("- just\n- a\n- list\n"));
    expect(intake.valid).toBe(false);
    expect(intake.issues[0]?.message).toBe("spec is not a YAML mapping");
  });

  it("handles a file that cannot be read", () => {
    const intake = loadSpecFile({
      service: "fixture-api",
      order: 1,
      fileName: "missing.yaml",
      relativePath: "fixtures/missing.yaml",
      absolutePath: join(mkdtempSync(join(tmpdir(), "cg-missing-")), "does-not-exist.yaml"),
    });
    expect(intake.valid).toBe(false);
    expect(intake.issues[0]?.message).toMatch(/could not read file/);
  });

  it("records version, title and owner for a valid spec", () => {
    const intake = loadSpecFile(fixtureRef(VALID_SPEC));
    expect(intake.valid).toBe(true);
    expect(intake.version).toBe("1.0.0");
    expect(intake.title).toBe("Fixture API");
    expect(intake.owner).toBe("Fixture team");
  });
});
