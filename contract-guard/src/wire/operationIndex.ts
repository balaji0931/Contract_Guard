/**
 * Build the wire index for one specification version: every operation with its
 * normalized path, internal flag, request fields (parameters plus request body)
 * and response fields per status code. Field paths use consumer notation, so a
 * consumer's `sends`/`reads` entry can be looked up directly (PLAN.md §5).
 */
import { HTTP_METHOD_SET, isPlainObject } from "../domain/openapi.js";
import { normalizePathTemplate } from "../domain/paths.js";
import { flattenSchema, type WireDirection, type WireField } from "./schemaWalker.js";

export interface IndexedParameter {
  name: string;
  in: string;
  required: boolean;
  type: string | null;
}

export interface IndexedOperation {
  method: string;
  pathTemplate: string;
  normalizedPath: string;
  operationId: string | null;
  summary: string | null;
  /** `x-internal: true` — excluded from consumer-impact checks (locked PO-1). */
  isInternal: boolean;
  parameters: IndexedParameter[];
  /** Request direction fields: parameters first, then request-body fields. */
  requestFields: WireField[];
  /** Response direction fields, grouped by status code. */
  responseFieldsByStatus: Array<{ statusCode: string; fields: WireField[] }>;
}

const JSON_CONTENT_TYPE = "application/json";

function collectParameters(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): IndexedParameter[] {
  const collected: IndexedParameter[] = [];
  const sources: unknown[] = [];
  if (Array.isArray(pathItem.parameters)) sources.push(...pathItem.parameters);
  if (Array.isArray(operation.parameters)) sources.push(...operation.parameters);

  for (const entry of sources) {
    if (!isPlainObject(entry) || typeof entry.name !== "string") continue;
    const location = typeof entry.in === "string" ? entry.in : "";
    const schema = isPlainObject(entry.schema) ? entry.schema : {};
    collected.push({
      name: entry.name,
      in: location,
      // Path parameters are required by the OpenAPI spec itself.
      required: entry.required === true || location === "path",
      type: typeof schema.type === "string" ? schema.type : null,
    });
  }
  return collected;
}

function parameterField(parameter: IndexedParameter): WireField {
  return {
    path: parameter.name,
    direction: "request",
    statusCode: null,
    type: parameter.type,
    format: null,
    required: parameter.required,
    enumValues: null,
    deprecated: false,
    sunsetDate: null,
  };
}

function jsonSchemaOf(container: unknown): unknown {
  if (!isPlainObject(container)) return undefined;
  const content = isPlainObject(container.content) ? container.content : undefined;
  const media = content?.[JSON_CONTENT_TYPE];
  if (!isPlainObject(media)) return undefined;
  return media.schema;
}

function requestFields(
  document: unknown,
  parameters: IndexedParameter[],
  operation: Record<string, unknown>,
): WireField[] {
  const fields: WireField[] = [];
  const seen = new Set<string>();

  for (const parameter of parameters) {
    if (seen.has(parameter.name)) continue;
    seen.add(parameter.name);
    fields.push(parameterField(parameter));
  }

  const bodySchema = jsonSchemaOf(operation.requestBody);
  if (bodySchema !== undefined) {
    for (const field of flattenSchema(document, bodySchema, { direction: "request" })) {
      if (field.path === "" || seen.has(field.path)) continue;
      seen.add(field.path);
      fields.push(field);
    }
  }
  return fields;
}

function responseFieldsByStatus(
  document: unknown,
  operation: Record<string, unknown>,
): Array<{ statusCode: string; fields: WireField[] }> {
  const responses = isPlainObject(operation.responses) ? operation.responses : {};
  const grouped: Array<{ statusCode: string; fields: WireField[] }> = [];

  for (const [statusCode, response] of Object.entries(responses)) {
    const schema = jsonSchemaOf(response);
    if (schema === undefined) continue;
    const fields = flattenSchema(document, schema, {
      direction: "response",
      statusCode,
    }).filter((field) => field.path !== "");
    if (fields.length > 0) grouped.push({ statusCode, fields });
  }
  return grouped;
}

/** Index every operation in a specification document. Never throws. */
export function indexOperations(document: unknown): IndexedOperation[] {
  if (!isPlainObject(document)) return [];
  const paths = isPlainObject(document.paths) ? document.paths : {};
  const indexed: IndexedOperation[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (!isPlainObject(pathItem)) continue;

    for (const [key, value] of Object.entries(pathItem)) {
      if (!HTTP_METHOD_SET.has(key.toLowerCase()) || !isPlainObject(value)) continue;
      const operation = value;
      const parameters = collectParameters(pathItem, operation);

      indexed.push({
        method: key.toUpperCase(),
        pathTemplate,
        normalizedPath: normalizePathTemplate(pathTemplate),
        operationId: typeof operation.operationId === "string" ? operation.operationId : null,
        summary: typeof operation.summary === "string" ? operation.summary : null,
        isInternal: operation["x-internal"] === true,
        parameters,
        requestFields: requestFields(document, parameters, operation),
        responseFieldsByStatus: responseFieldsByStatus(document, operation),
      });
    }
  }
  return indexed;
}

/** All fields of an operation, request and response together. */
export function allFields(operation: IndexedOperation): WireField[] {
  return [
    ...operation.requestFields,
    ...operation.responseFieldsByStatus.flatMap((group) => group.fields),
  ];
}

export function fieldCount(operation: IndexedOperation): number {
  return allFields(operation).length;
}

/**
 * Comparable view of an index: sorted field keys per operation, addressed by
 * method and normalized path only. Renamed components never appear, and path
 * parameter names are excluded from the request side because the wire path —
 * not the name — is what consumers actually address (D-2, D-3).
 */
export function comparableIndex(operations: IndexedOperation[]): string[] {
  return operations
    .map((operation) => {
      const requestPaths = operation.requestFields
        .filter((field) => !operation.parameters.some((parameter) => parameter.name === field.path))
        .map((field) => wireKey(field));
      const responses = operation.responseFieldsByStatus
        .flatMap((group) => group.fields.map((field) => wireKey(field)))
        .sort();
      return [
        `${operation.method} ${operation.normalizedPath}`,
        `internal=${operation.isInternal}`,
        `params=${operation.parameters
          .map((parameter) => `${parameter.in}:${parameter.type ?? "-"}:${parameter.required ? "required" : "optional"}`)
          .sort()
          .join(",")}`,
        `request=${requestPaths.sort().join(",")}`,
        `response=${responses.join(",")}`,
      ].join(" | ");
    })
    .sort();
}

function wireKey(field: WireField): string {
  return [
    field.direction,
    field.statusCode ?? "-",
    field.path,
    field.type ?? "opaque",
    field.format ?? "-",
    field.required ? "required" : "optional",
    field.enumValues ? field.enumValues.join("|") : "-",
    field.deprecated ? "deprecated" : "-",
    field.sunsetDate ?? "-",
  ].join(":");
}

export type { WireDirection };
