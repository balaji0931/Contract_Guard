# DECISIONS.md — Contract Guard decision log

> **Status: DRAFT — under review, not frozen.**
> This log records *what* was decided, *why*, and *when*. Append new decisions at the bottom; never rewrite history.
>
> ℹ️ **Note:** This plan and this log were prepared with AI assistance. All decisions below were made through discussions between the product owner and the engineering team (assistant: OpenCode agent — discovery, analysis and drafting).

---

## 1. Product-owner clarifications (source of the core rules)

| # | Decision | Choice | Why | Consequence |
|---|---|---|---|---|
| PO-1 | `x-internal` endpoints | **Skip consumer-impact checks** for internal operations | They are backend/caching routes (e.g. `/internal/pricing-cache`) that external apps never touch; checking them would throw false alarms | They are still parsed, validated and listed in the registry — just excluded from the blocking gate and consumer impact |
| PO-2 | Breaking changes | **Completely block the publish** + alert the webhook receiver | Makes Contract Guard a real security guard instead of a quiet logger | A blocked version never becomes `published`; it can never become the diff baseline |
| PO-3 | `x-sunset` dates | **Notify** on deprecation and on overdue sunsets; **removal after expiry = hard-breaking** | Keeps API contracts clean; ensures nobody still using an old field is silently broken | Removal past sunset blocks even with zero known consumers; `legacyCode` (sunset 2026-11-01) is already overdue in the kit |
| PO-4 | Ingest model | **Auto-read spec and consumer files from local folders at startup** | Saves manual work; everything is loaded instantly for the demo | `specs/` and `consumers/` are read-only, always; manual upload (`POST /api/specs`) still available |
| PO-5 | Version collisions | **Reject** any new version reusing an existing `info.version` | Protects the registry — no accidental overwrites, no data chaos | claims-api's corrected spec (also `1.1.0`) is rejected with guidance: "publish as 1.1.1" |

## 2. Derived design decisions (from the team, with AI analysis)

| # | Decision | Choice | Why |
|---|---|---|---|
| D-1 | Gate mode default | `GATE_MODE=consumer` (block on known-consumer impact **or** past-sunset removal); `strict` available via env | With this kit the outcome is identical under both modes; `consumer` avoids punishing harmless additions when no consumer is exposed. One env var flips to full strictness |
| D-2 | Diff granularity | **Wire-field based** (flattened paths like `premium.breakdown[].amount`), not schema-name based | quote-api 1.1.0 renames components/inlines objects with zero wire change — name-based diffing would produce false positives (trap #1 in the kit) |
| D-3 | Path matching | **Template-shape normalization** (`{id}` ≡ `{quoteId}` → `/quotes/{}`) + param alias map | Consumer files say `/quotes/{id}` while newer specs say `/quotes/{quoteId}`; literal matching would flag the refactor as breaking |
| D-4 | Diff baseline | Last **published** version, skipping blocked ones | A blocked version never shipped; diffing against it would misstate reality (cascading blocks are expected and accepted) |
| D-5 | Startup behavior | **Auto-load + auto-publish in filename order** (PO-4 + PO-2 combined) | Blocks and webhook alerts fire with zero manual steps, so an evaluator polling `GET /api/received` sees the guard act on its own. Re-publish from UI/API still possible |
| D-6 | Restart semantics | **Fresh state on startup** (replay the pipeline; `CG_FRESH` toggle) | A persistent DB would make a second demo run silent (versions already decided, receiver empty). Fresh state replays blocks/alerts every launch; previous run remains as history in the DB |
| D-7 | App location | `contract-guard/` at repo root; kit read via `KIT_ROOT` | Kit rule: evaluators test against original `specs/` and `consumers/` — the app must live elsewhere and never write to them |

## 3. Tech-stack decisions

| # | Decision | Choice | Why (incl. alternatives considered) |
|---|---|---|---|
| T-1 | Runtime / framework | **Node.js + Express + TypeScript** | Team's choice. Express is ubiquitous, well-understood for a small HTTP API + dashboard; TS gives type safety across the diff/gate domain model |
| T-2 | Database driver | **`better-sqlite3`** (supersedes the earlier `sqlite3` note) | Synchronous API means simpler transactions and less boilerplate in Express; the gate's verdict + status write + audit row commit atomically in one transaction — exactly what a blocking guard needs. Alternatives considered: `sqlite3` (callback-based, would need a promise wrapper), `node:sqlite` built-in (zero deps, slightly less mature) |
| T-3 | OpenAPI parsing/diff | **Custom differ + `js-yaml`** | We must *report* the broken `$ref` (`ClaimDocumnt`) as a finding, not crash: a validating parser throws before we can. A controlled rulebook also gives deterministic output for evaluators. Alternative considered: `@apidevtools/swagger-parser` (free structural validation, but its validity opinion leaks into ours) |
| T-4 | Tests | **`vitest` + `supertest`** | Golden-file tests over all 12 kit specs + end-to-end webhook assertion against the acceptance matrix (5 published / 6 blocked / 1 rejected) |
| T-5 | UI scope | **Dashboard with read + publish actions** | Version timeline, findings, consumer risks, sent-alert log; re-publish buttons let us re-demo a block live |

## 4. Context: the kit's planted traps these decisions answer

| Trap (from discovery) | Answered by |
|---|---|
| Refactor false positives (quote 1.1.0 renames) | D-2, D-3 |
| Broken `$ref` (claims 1.1.0) | T-3, matrix row 10 |
| Duplicate version collision (claims "fixed") | PO-5, matrix row 11 |
| Semantics beyond required lists (claims 2.0.0) | D-2, rulebook §6 of PLAN.md |
| Time-based policy (`x-sunset`, one already overdue) | PO-3, sunset engine |
| Unknown `x-internal` semantics | PO-1 |
| Consumer paths vs spec paths (`{id}` vs `{quoteId}`) | D-3 |
| Version truth in `info.version`, not filename | Loader (PLAN.md §5) |

---

*Prepared with AI assistance (OpenCode). Under review — not frozen.*
