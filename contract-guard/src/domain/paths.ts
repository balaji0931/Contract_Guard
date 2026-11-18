/** Path-template normalization (locked decision D-3/L-1 foundation). */

/**
 * Collapse every `{param}` to `{}` so `/quotes/{id}` and `/quotes/{quoteId}`
 * compare equal on the wire, regardless of parameter naming.
 */
export function normalizePathTemplate(pathTemplate: string): string {
  return pathTemplate.replace(/\{[^}]*\}/g, "{}");
}

/** `GET /quotes/{quoteId}` style label used in findings and alerts. */
export function operationRef(method: string, pathTemplate: string): string {
  return `${method.toUpperCase()} ${pathTemplate}`;
}
