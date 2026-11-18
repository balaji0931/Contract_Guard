/**
 * Wire index (PLAN.md §5 "Wire Index"): flatten a resolved OpenAPI schema into
 * wire field paths that use the same notation as consumer manifests
 * (`premium.breakdown[].amount`). Flattening happens after `$ref` resolution,
 * so component names (`Premium` vs `PremiumDetails`) never reach the index and a
 * pure refactor produces an identical index (locked decision D-2).
 */

export const WIRE_DIRECTIONS = ["request", "response"] as const;
export type WireDirection = (typeof WIRE_DIRECTIONS)[number];

export interface WireField {
  /** Field path in consumer notation, e.g. `premium.breakdown[].amount`. */
  path: string;
  direction: WireDirection;
  /** Response status code, or `null` for request fields. */
  statusCode: string | null;
  type: string | null;
  format: string | null;
  required: boolean;
  enumValues: string[] | null;
  deprecated: boolean;
  /** `x-sunset` calendar date (L-4), or `null`. */
  sunsetDate: string | null;
}

import { isPlainObject, resolveLocalPointer } from "../domain/openapi.js";

export { isPlainObject, resolveLocalPointer };

const MAX_DEPTH = 64;

/** Follow a chain of internal `$ref`s. Returns `ok: false` when unresolvable. */
export function resolveRefChain(document: unknown, node: unknown): { ok: boolean; node?: unknown } {
  const visited = new Set<string>();
  let current = node;

  while (isPlainObject(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    if (visited.has(ref)) return { ok: false };
    visited.add(ref);
    const resolved = resolveLocalPointer(document, ref);
    if (!resolved.ok) return { ok: false };
    current = resolved.value;
  }
  return { ok: true, node: current };
}

interface WalkContext {
  document: unknown;
  direction: WireDirection;
  statusCode: string | null;
  /** Refs currently being expanded, to stop a cyclic schema from looping forever. */
  expanding: Set<string>;
  fields: WireField[];
}

function describeNode(node: Record<string, unknown>): Pick<
  WireField,
  "type" | "format" | "enumValues" | "deprecated" | "sunsetDate"
> {
  const enumValues = Array.isArray(node.enum)
    ? node.enum.filter((value) => typeof value === "string" || typeof value === "number").map(String)
    : null;
  const sunset = node["x-sunset"];
  return {
    type: typeof node.type === "string" ? node.type : null,
    format: typeof node.format === "string" ? node.format : null,
    enumValues,
    deprecated: node.deprecated === true,
    sunsetDate: typeof sunset === "string" ? sunset : null,
  };
}

function walkNode(
  node: unknown,
  path: string,
  required: boolean,
  depth: number,
  context: WalkContext,
): void {
  if (depth > MAX_DEPTH) return;

  // An unresolvable `$ref` is still a field on the wire: record it opaquely
  // (type `null`) instead of failing, so validation can report the real problem.
  if (isPlainObject(node) && typeof node.$ref === "string") {
    const ref = node.$ref;
    if (context.expanding.has(ref)) {
      context.fields.push(opaqueField(path, required, context));
      return;
    }
    const resolved = resolveRefChain(context.document, node);
    if (!resolved.ok) {
      context.fields.push(opaqueField(path, required, context));
      return;
    }
    context.expanding.add(ref);
    walkNode(resolved.node, path, required, depth, context);
    context.expanding.delete(ref);
    return;
  }

  if (!isPlainObject(node)) return;

  const declared = typeof node.type === "string" ? node.type : inferType(node);
  context.fields.push({
    path,
    direction: context.direction,
    statusCode: context.statusCode,
    ...describeNode(node),
    type: declared,
    required,
  });

  if (declared === "object" || (!declared && isPlainObject(node.properties))) {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const requiredList = Array.isArray(node.required) ? node.required.map(String) : [];
    for (const [name, child] of Object.entries(properties)) {
      walkNode(
        child,
        path === "" ? name : `${path}.${name}`,
        requiredList.includes(name),
        depth + 1,
        context,
      );
    }
    return;
  }

  if (declared === "array" && node.items !== undefined) {
    // Array items extend the path with `[]`, matching consumer notation, and
    // inherit the array's own requiredness so the value is stable across versions.
    walkNode(node.items, `${path}[]`, required, depth + 1, context);
  }
}

function inferType(node: Record<string, unknown>): string | null {
  if (isPlainObject(node.properties)) return "object";
  if (node.items !== undefined) return "array";
  return null;
}

function opaqueField(path: string, required: boolean, context: WalkContext): WireField {
  return {
    path,
    direction: context.direction,
    statusCode: context.statusCode,
    type: null,
    format: null,
    required,
    enumValues: null,
    deprecated: false,
    sunsetDate: null,
  };
}

/**
 * Flatten a schema (which may itself be a `$ref`) into wire fields. The root
 * object contributes no field of its own, only its properties.
 */
export function flattenSchema(
  document: unknown,
  schema: unknown,
  options: { direction: WireDirection; statusCode?: string | null },
): WireField[] {
  const context: WalkContext = {
    document,
    direction: options.direction,
    statusCode: options.statusCode ?? null,
    expanding: new Set<string>(),
    fields: [],
  };

  const resolved = resolveRefChain(document, schema);
  const target = resolved.ok ? resolved.node : schema;
  if (!isPlainObject(target)) return context.fields;

  const properties = isPlainObject(target.properties) ? target.properties : {};
  const requiredList = Array.isArray(target.required) ? target.required.map(String) : [];
  for (const [name, child] of Object.entries(properties)) {
    walkNode(child, name, requiredList.includes(name), 1, context);
  }

  // A root that is an array or a scalar still needs its own entry.
  if (Object.keys(properties).length === 0 && (target.type === "array" || target.items !== undefined)) {
    walkNode(target, "", true, 1, context);
  }

  return context.fields;
}

/** Stable key used when comparing two indexes for equality. */
export function wireFieldKey(field: WireField): string {
  return [
    field.direction,
    field.statusCode ?? "-",
    field.path,
    field.type ?? "-",
    field.format ?? "-",
    field.required ? "required" : "optional",
    field.enumValues ? field.enumValues.join("|") : "-",
    field.deprecated ? "deprecated" : "-",
    field.sunsetDate ?? "-",
  ].join("\u0000");
}
