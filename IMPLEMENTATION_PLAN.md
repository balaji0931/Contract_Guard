# Contract Guard — Implementation Plan

**Status: Ready for review and commit.** All clarifications are resolved and locked below. No implementation is authorized until the user explicitly instructs Phase 0.

## Rules for every phase

- Before any work, read `PLAN.md`, `DECISIONS.md`, and `IMPLEMENTATION_PLAN.md`.
- `specs/` and `consumers/` are strictly read-only and must never be changed, including during tests.
- If anything is unclear or requires a decision change, **stop and ask the user**; do not guess. Record approved changes in the relevant documents before proceeding.
- Work on one phase at a time. Do not start the next phase until the current phase is fully built, all its tests pass, the user has reviewed it, the user has committed it to Git, **and the user explicitly instructs you to start the next phase**. Do not commit on the user's behalf.
- For each phase, report changes, test results, and any blockers for review. The definition of done includes these rules and all earlier tests continuing to pass.

## Locked decisions (all clarifications resolved)

| # | Topic | Locked behavior |
|---|---|---|
| L-1 | Gate policy | `GATE_MODE=consumer` is the default. Block when a change breaks a **known consumer** or is a **past-sunset field removal**. Unconsumed public breaking changes **publish with recorded warnings**. `x-internal` operations skip consumer-impact checks entirely (still parsed, validated, listed). `GATE_MODE=strict` remains available via env for later policy change. |
| L-2 | Version reservation | Any intake that occupies a version number **reserves it** — `published`, `blocked`, and `invalid` all count. A later file with the same `info.version` is **rejected** with code `ERR_DUPLICATE_VERSION` and guidance to publish the next number (claims-api corrected file → "publish as 1.1.1"). |
| L-3 | Restart behavior | `CG_FRESH=1` by default: every startup replays the full pipeline (loads, publishes, re-alerts) so demos show live blocking and receiver traffic. Prior runs are retained in DB audit history (`events`, `alerts`) and are **not** used to dedupe or skip the replay. |
| L-4 | Sunset handling | `CG_AS_OF_DATE` pins "today"; the pinned acceptance run uses **`2026-11-18`**, which makes `legacyCode` (sunset `2026-11-01`) overdue. Removing a field whose sunset is **passed** is a hard block regardless of consumers. Removing one whose sunset is **still future** (e.g. `holder.phone`, `2027-06-30`) is a warning, not a block, under L-1. Sunset dates are compared as calendar dates in IST; a sunset equal to the as-of date counts as due. |
| L-5 | Enum impact | A consumer manifest that names an enum field without listing values gets the **conservative** verdict: removing an enum option from a field that consumer sends is a breaking finding (partner-portal sends `type` → `VEHICLE` removal breaks it). The finding text states it is a possible-usage match, not proof. |
| L-6 | Codes and payloads | Finding codes come from the canonical vocabulary below; add new ones only with the same `ERR_`/`WARN_` convention. All alerts POST JSON to `WEBHOOK_URL` (default `http://localhost:9900`) using the paths and payload shape in `PLAN.md` §8. |

### Canonical finding codes

| Code | Severity | Meaning |
|---|---|---|
| `ERR_BREAKING_FIELD_REMOVED` | blocking | Response/request field no longer exists |
| `ERR_BREAKING_FIELD_NOW_OPTIONAL` | blocking | Response field removed from `required` (may be absent) |
| `ERR_BREAKING_FIELD_NOW_REQUIRED` | blocking | Request field/param added or made required |
| `ERR_BREAKING_ENUM_VALUE_REMOVED` | blocking | Enum option removed from a sent field (L-5) |
| `ERR_BREAKING_TYPE_CHANGED` | blocking | Field type or format changed |
| `ERR_BREAKING_OPERATION_REMOVED` | blocking | Path+method a consumer calls is gone |
| `ERR_SUNSET_REMOVAL_EXPIRED` | blocking | Deprecated field removed on/after its `x-sunset` date (L-4) |
| `ERR_INVALID_SPEC` | blocking | Spec failed validation (e.g. unresolved `$ref`) |
| `ERR_DUPLICATE_VERSION` | intake reject | `info.version` already reserved (L-2) |
| `WARN_DEPRECATED_FIELD` | warning | Field newly `deprecated: true`, with sunset date |
| `WARN_SUNSET_OVERDUE` | warning | Sunset date passed, field still present and still consumed |
| `WARN_UNCONSUMED_BREAKING` | warning | Breaking diff with no known consumer impact (publishes under L-1) |
| `WARN_INTERNAL_CHANGE_NOTED` | info | Change on an `x-internal` operation, excluded from the gate |

## Phase roadmap

**Done for each phase:** its deliverables are complete; the exact tests below and all earlier tests pass; results are reported; the user reviews and commits the phase. Wait for explicit authorization before moving on.

| Phase | Deliverables | Exact tests / phase-specific done criteria |
|---|---|---|
| **0 — Foundation** | Scaffold `contract-guard/` with Node.js, Express, TypeScript, `better-sqlite3`, configuration, logging, DB initialization and migrations. | Prerequisite (user-owned): Git repo must exist before the phase-commit workflow — the inspected folder was not a Git repository. TypeScript build succeeds; health endpoint returns success; temporary SQLite DB initializes and migrations rerun safely; invalid configuration fails clearly. |
| **1 — Loading and validation** | Read ordered local files; parse YAML, extract `info.version`, validate specs and internal references, record intake results. | Load all 12 spec files and 4 consumers in numeric order per service; detect claims `ClaimDocumnt` as `ERR_INVALID_SPEC` without crashing; accept its corrected reference; detect duplicate operation IDs and malformed input in isolated fixtures. |
| **2 — Wire and consumer indexes** | Resolve schemas into request/response field paths; index consumers; normalize operation paths and parameter aliases. | Quote 1.0.0 and 1.1.0 produce equivalent wire indexes; `/quotes/{id}` matches `/quotes/{quoteId}`; resolve `premium.breakdown[].amount`, body fields and path parameters; index all four consumers. |
| **3 — Diff engine** | Implement the PLAN.md §6 rulebook, emitting the L-6 code vocabulary, against the last published baseline. | Quote 1→2 has no breaking wire changes; quote 2→3 detects `amount` removal; policy detects removed fields, required `requestedBy` and `VEHICLE` removal; claims detects `amountApproved` becoming optional; additive fields are not breaking. |
| **4 — Consumer impact** | Match findings to consumers and their declared reads/sends; apply L-1 internal-endpoint exclusion and L-5 conservative enum rule. | Identify mobile's quote `amount` and claims `amountApproved`, payments' `legacyCode`, and partner's missing `requestedBy`; do not report internal pricing-cache consumer impact; a removed enum option on a field the consumer sends is reported as breaking with possible-usage wording (L-5). |
| **5 — Publication gate** | Apply L-1 gate, validation, L-2 version reservation and last-published baseline atomically; store verdicts and audit records. | First valid version publishes; a consumer-impacting breaking candidate blocks without becoming baseline; an unconsumed breaking change publishes with `WARN_UNCONSUMED_BREAKING`; later candidates compare with last published version; duplicate-version and invalid-spec outcomes follow L-2; simulated DB failure rolls back verdict and audit together. |
| **6 — Notifications** | Send webhook alerts to `WEBHOOK_URL` and persist attempts; retry without changing gate outcomes. | Test receiver gets a block summary and affected-consumer alert with PLAN.md §8 payloads and L-6 codes; failure and retry are recorded; an unavailable receiver does not publish a blocked candidate or crash the gate. |
| **7 — Startup and sunsets** | Auto-scan consumers and specs, attempt publication in file order, run sunset checks; apply L-3 restart behavior. | With `CG_AS_OF_DATE=2026-11-18` and an isolated DB, assert all 12 outcomes and the 5/6/1 totals in `PLAN.md` §7; verify filename ordering, `WARN_SUNSET_OVERDUE` for `legacyCode`, `ERR_SUNSET_REMOVAL_EXPIRED` for its removal, future-sunset warnings for `holder.phone`, and L-4 date-boundary comparisons; restart twice and assert L-3 (pipeline replays, alerts re-fire, prior run retained in history). |
| **8 — API and dashboard** | Implement the agreed registry, findings, consumers, alerts, recheck and publish endpoints; add dashboard read and publish actions. Dashboard UI is a **React + Vite + Tailwind CSS** SPA in `contract-guard/client/` (lucide-react icons) per the PO instruction of 2026-11-18, superseding the server-rendered HTML template. | HTTP tests verify each documented endpoint's success and error cases; dashboard displays versions, findings, risks and alerts; publish action invokes the same gate and cannot bypass blocking or duplicate rules. |
| **9 — Acceptance and documentation** | Complete end-to-end coverage and demo instructions. | Run the complete suite on a clean isolated DB; verify every matrix row and totals, impacted consumers, internal exclusion, and actual webhook receipt; verify startup/restart and input folders remain byte-identical; follow demo instructions successfully. |

**Current checkpoint:** All six clarifications are resolved (L-1…L-6) and the roadmap is ready. Await user review and Git commit of these documents, plus `git init` if not already done. Do not begin Phase 0 until the user explicitly instructs it.
