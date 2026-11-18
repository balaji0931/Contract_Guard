/**
 * Canonical finding-code vocabulary (locked decision L-6, IMPLEMENTATION_PLAN.md
 * §"Canonical finding codes"). Every finding the system emits must use one of
 * these codes; new codes may only be added with the same ERR_/WARN_ convention.
 */

export const FINDING_SEVERITIES = ["blocking", "warning", "info", "intake_reject"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CODES = {
  /** Response/request field no longer exists. */
  ERR_BREAKING_FIELD_REMOVED: "blocking",
  /** Response field removed from `required` (it may now be absent). */
  ERR_BREAKING_FIELD_NOW_OPTIONAL: "blocking",
  /** Request field/param added or made required. */
  ERR_BREAKING_FIELD_NOW_REQUIRED: "blocking",
  /** Enum option removed from a field a consumer sends (L-5). */
  ERR_BREAKING_ENUM_VALUE_REMOVED: "blocking",
  /** Field type or format changed. */
  ERR_BREAKING_TYPE_CHANGED: "blocking",
  /** Path+method a consumer calls is gone. */
  ERR_BREAKING_OPERATION_REMOVED: "blocking",
  /** Deprecated field removed on/after its `x-sunset` date (L-4). */
  ERR_SUNSET_REMOVAL_EXPIRED: "blocking",
  /** Spec failed validation (e.g. unresolved `$ref`). */
  ERR_INVALID_SPEC: "blocking",
  /** `info.version` already reserved (L-2). */
  ERR_DUPLICATE_VERSION: "intake_reject",
  /** Field newly `deprecated: true`, with sunset date. */
  WARN_DEPRECATED_FIELD: "warning",
  /** Sunset date passed, field still present and still consumed. */
  WARN_SUNSET_OVERDUE: "warning",
  /** Breaking diff with no known consumer impact (publishes under L-1). */
  WARN_UNCONSUMED_BREAKING: "warning",
  /**
   * New enum option added to a returned field — PLAN.md §6 rates this a
   * warning (exhaustive-switch risk). Added under L-6's rule that new codes
   * may follow the same `ERR_`/`WARN_` convention.
   */
  WARN_ENUM_VALUE_ADDED: "warning",
  /** Change on an `x-internal` operation, excluded from the gate. */
  WARN_INTERNAL_CHANGE_NOTED: "info",
} as const satisfies Record<string, FindingSeverity>;

export type FindingCode = keyof typeof FINDING_CODES;

export const FINDING_CODE_LIST = Object.keys(FINDING_CODES) as FindingCode[];

export function severityOf(code: FindingCode): FindingSeverity {
  return FINDING_CODES[code];
}

export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  message: string;
  /** `METHOD /path/template` when the finding concerns one operation. */
  operationRef?: string;
  /** Wire field path, e.g. `premium.breakdown[].amount`. */
  fieldPath?: string;
  /** Consumer name when the finding is attributed to one. */
  consumerName?: string;
}

export interface FindingOptions {
  operationRef?: string;
  fieldPath?: string;
  consumerName?: string;
}

export function finding(code: FindingCode, message: string, options: FindingOptions = {}): Finding {
  return {
    code,
    severity: severityOf(code),
    message,
    ...(options.operationRef === undefined ? {} : { operationRef: options.operationRef }),
    ...(options.fieldPath === undefined ? {} : { fieldPath: options.fieldPath }),
    ...(options.consumerName === undefined ? {} : { consumerName: options.consumerName }),
  };
}

export function isBlocking(findingValue: Finding): boolean {
  return findingValue.severity === "blocking";
}

/** Guidance recorded with an `ERR_DUPLICATE_VERSION` rejection (L-2). */
export const DUPLICATE_VERSION_GUIDANCE =
  "version numbers are never reused: publish this content under the next version number";
