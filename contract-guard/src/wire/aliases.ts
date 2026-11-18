/**
 * Path-template parameters and rename aliases (locked decision D-3).
 *
 * `/quotes/{id}` and `/quotes/{quoteId}` are the same wire path, so a parameter
 * rename is a refactor, not a breaking change. Consumers were written against
 * the older names, so resolution applies a positional alias map derived from
 * the two templates: `{id}` in one, `{quoteId}` in the other, same position.
 */

const PARAM_IN_BRACES = /\{([^}]*)\}/g;

/** Ordered parameter names of a path template: `/quotes/{quoteId}` → `["quoteId"]`. */
export function templateParams(pathTemplate: string): string[] {
  return [...pathTemplate.matchAll(PARAM_IN_BRACES)].map((match) => match[1] as string);
}

/**
 * Positional rename map from one template to another. Only names that differ
 * are recorded; templates with a different number of parameters yield an empty
 * map because they are not the same wire path.
 */
export function buildParamAliasMap(fromTemplate: string, toTemplate: string): Record<string, string> {
  const from = templateParams(fromTemplate);
  const to = templateParams(toTemplate);
  if (from.length !== to.length) return {};

  const aliases: Record<string, string> = {};
  from.forEach((name, index) => {
    const target = to[index];
    if (target !== undefined && target !== name) aliases[name] = target;
  });
  return aliases;
}

/** Rewrite the first segment of a field path when it names a renamed parameter. */
export function applyParamAlias(fieldPath: string, aliases: Record<string, string>): string {
  const [head, ...rest] = fieldPath.split(".");
  if (head === undefined) return fieldPath;
  // Strip any `[]` suffix from the head segment before lookup.
  const bare = head.replace(/\[\]$/, "");
  const suffix = head.slice(bare.length);
  const mapped = aliases[bare];
  return [mapped === undefined ? head : `${mapped}${suffix}`, ...rest].join(".");
}

/** True when the templates address the same wire path, regardless of names. */
export function sameWirePath(left: string, right: string): boolean {
  return left.replace(PARAM_IN_BRACES, "{}") === right.replace(PARAM_IN_BRACES, "{}");
}
