/**
 * Spec validation (PLAN.md §5 "Validator"): resolve internal `$ref`s and report
 * dangling references, duplicate operation IDs and duplicate path+method
 * combinations. Every problem is an `ERR_INVALID_SPEC` finding — validation
 * never throws, so an invalid spec is reported instead of crashing the pipeline.
 */

import { finding, type Finding } from "../findings/codes.js";
import { normalizePathTemplate } from "../domain/paths.js";
import { HTTP_METHOD_SET, isPlainObject, resolveLocalPointer } from "../domain/openapi.js";

export interface ReferenceIssue {
  ref: string;
  /** Dot path to the offending `$ref`, e.g. `paths./claims.get.responses.200...$ref`. */
  location: string;
}

/** Collect every `$ref` string in a document with a readable location. */
export function collectReferences(document: unknown): ReferenceIssue[] {
  const found: ReferenceIssue[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}.${index}`));
      return;
    }
    if (!isPlainObject(node) || seen.has(node)) return;
    seen.add(node);

    const ref = node.$ref;
    if (typeof ref === "string") found.push({ ref, location: path });

    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") continue;
      walk(value, `${path}.${key}`);
    }
  };

  walk(document, "");
  return found;
}

/** Pointer resolution lives in the domain layer; re-exported for validators. */
export { resolveLocalPointer };

interface OperationScan {
  method: string;
  pathTemplate: string;
  operationId?: string;
}

function collectOperations(paths: Record<string, unknown>): OperationScan[] {
  const operations: OperationScan[] = [];
  for (const [pathTemplate, item] of Object.entries(paths)) {
    if (!isPlainObject(item)) continue;
    for (const [key, value] of Object.entries(item)) {
      if (!HTTP_METHOD_SET.has(key.toLowerCase())) continue;
      const operation = isPlainObject(value) ? value : undefined;
      const operationId = typeof operation?.operationId === "string" ? operation.operationId : undefined;
      operations.push({ method: key.toUpperCase(), pathTemplate, operationId });
    }
  }
  return operations;
}

/**
 * Validate a parsed OpenAPI document. Returns one `ERR_INVALID_SPEC` finding per
 * problem; an empty array means the spec is structurally sound.
 */
export function validateSpec(document: unknown): Finding[] {
  const issues: Finding[] = [];

  if (!isPlainObject(document)) {
    return [finding("ERR_INVALID_SPEC", "spec is not a YAML mapping")];
  }

  const info = isPlainObject(document.info) ? document.info : undefined;
  if (!info) {
    issues.push(finding("ERR_INVALID_SPEC", "spec has no `info` block"));
  } else if (typeof info.version !== "string" || info.version.trim() === "") {
    issues.push(finding("ERR_INVALID_SPEC", "spec has no usable `info.version`"));
  }

  const paths = isPlainObject(document.paths) ? document.paths : undefined;
  if (!paths) {
    issues.push(finding("ERR_INVALID_SPEC", "spec has no `paths` block"));
  } else {
    const operations = collectOperations(paths);
    if (operations.length === 0) {
      issues.push(finding("ERR_INVALID_SPEC", "spec declares no operations under `paths`"));
    }

    // Duplicate operation IDs.
    const seenIds = new Map<string, number>();
    for (const operation of operations) {
      if (operation.operationId === undefined) continue;
      seenIds.set(operation.operationId, (seenIds.get(operation.operationId) ?? 0) + 1);
    }
    for (const [operationId, count] of seenIds) {
      if (count > 1) {
        issues.push(
          finding("ERR_INVALID_SPEC", `operationId "${operationId}" is declared ${count} times`),
        );
      }
    }

    // Duplicate path+method, judged on the normalized template so
    // `/quotes/{id}` and `/quotes/{x}` collide the way they would on the wire.
    const seenOperations = new Map<string, string[]>();
    for (const operation of operations) {
      const key = `${operation.method} ${normalizePathTemplate(operation.pathTemplate)}`;
      const templates = seenOperations.get(key) ?? [];
      templates.push(operation.pathTemplate);
      seenOperations.set(key, templates);
    }
    for (const [key, templates] of seenOperations) {
      if (templates.length > 1) {
        issues.push(
          finding(
            "ERR_INVALID_SPEC",
            `${key} is declared more than once (paths: ${templates.join(", ")})`,
          ),
        );
      }
    }
  }

  // Internal reference resolution.
  for (const reference of collectReferences(document)) {
    if (!reference.ref.startsWith("#")) {
      issues.push(
        finding(
          "ERR_INVALID_SPEC",
          `external $ref "${reference.ref}" is not supported (kit specs reference inside their own file) at ${reference.location}`,
        ),
      );
      continue;
    }
    const resolved = resolveLocalPointer(document, reference.ref);
    if (!resolved.ok) {
      const name = reference.ref.split("/").pop() ?? reference.ref;
      issues.push(
        finding("ERR_INVALID_SPEC", `unresolved $ref "${reference.ref}" (no such component "${name}") at ${reference.location}`),
      );
    }
  }

  return issues;
}
