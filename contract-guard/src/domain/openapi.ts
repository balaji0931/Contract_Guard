/** Shared OpenAPI document primitives used by validation and the wire index. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve an RFC 6901 JSON pointer rooted at the document, e.g.
 * `#/components/schemas/Quote`. Only same-document pointers are supported,
 * which matches the kit's rule that all references point inside their own file.
 */
export function resolveLocalPointer(
  document: unknown,
  ref: string,
): { ok: boolean; value?: unknown } {
  if (!ref.startsWith("#/")) return { ok: false };
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { ok: false };
      current = current[index];
      continue;
    }
    if (!isPlainObject(current) || !(segment in current)) return { ok: false };
    current = current[segment];
  }
  return { ok: true, value: current };
}

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export const HTTP_METHOD_SET: ReadonlySet<string> = new Set<string>(HTTP_METHODS);
