# PLAN.md — Contract Guard

> **Status: decisions locked; awaiting review + Git commit.** Resolved by `IMPLEMENTATION_PLAN.md` L-1…L-6 and recorded in `DECISIONS.md`.
> Built from the starter-kit discovery + product-owner clarifications.

---

## 1. Core problem

Teams publish OpenAPI specifications for shared APIs (`quote-api`, `policy-api`, `claims-api`) while four consumer services depend on them. Nothing currently stands between the two: a provider can publish a spec that silently breaks a consumer — a renamed response field, a removed enum value, a newly required request field, a deleted field consumers still read.

**Contract Guard** is the API contract registry that sits in the middle:

1. **Ingest** every spec version and consumer manifest.
2. **Validate** specs (internal `$ref` resolution, structural checks) and survive invalid ones by reporting them, not crashing.
3. **Diff** successive published versions and classify every change as breaking / warning / additive / refactor-noise — on the *wire*, not on schema names.
4. **Check consumer impact** — match each consumer's `sends`/`reads` field paths against the candidate version's wire contract.
5. **Gate publication** — a breaking change to a known consumer **blocks the publish** (the version never becomes `published`) and fires alerts.
6. **Track deprecations & sunsets** — `x-sunset` dates create time-based obligations; removal after expiry is hard-breaking.
7. **Notify** — every block, rejection, deprecation and overdue sunset is POSTed to the webhook receiver (`:9900`), which stands in for chat/email.

## 2. Scope

### In scope
- Auto-load `specs/` and `consumers/` from the local folders at startup (**read-only** — these folders are never modified).
- Auto-publish each service's versions in filename order through the publication gate.
- Semantic diff engine with a deterministic classification rulebook (wire-field based, `$ref`-resolved, path-template normalized).
- Consumer impact engine (request-side and response-side field checks).
- Publication gate with statuses `published | blocked | rejected`, reason codes and a full audit trail.
- Sunset/deprecation engine (startup scan + `POST /api/recheck`).
- Webhook notifier with per-path routing, retries, and an alert log in the DB.
- HTTP API + dashboard UI — React + Vite + Tailwind SPA (read + publish/re-publish actions).
- SQLite persistence (`better-sqlite3`), fresh state on each startup.
- Acceptance tests asserting the 12-file matrix end-to-end (including webhook delivery).

### Out of scope
- Modifying anything in `specs/` or `consumers/` (evaluators test against the original kit).
- Git integration, CI plugins, code generation, API client SDKs.
- Multi-tenant auth/RBAC; external spec sources (URLs, registries) beyond manual `POST /api/specs`.

## 3. Product-owner rules (locked)

| # | Area | Rule |
|---|---|---|
| 1 | `x-internal` operations | **Skip consumer-impact checks.** Backend/caching routes (e.g. `/internal/pricing-cache`) don't touch external apps — they must not throw false alarms. Still parsed, validated and listed in the registry. |
| 2 | Breaking changes | **Block the publication entirely** + alert the webhook receiver. A real security guard, not a quiet logger. |
| 3 | `x-sunset` | Send notifications (deprecation notice at publish; overdue alert once the date passes). **Removing a field after its expiry date is hard-breaking** — always blocks, even if no known consumer reads it. |
| 4 | Ingest model | App **auto-reads spec and consumer files from local folders at startup**. No manual work; everything loaded instantly for the demo. |
| 5 | Version collisions | **Reject** any new version whose `info.version` already exists in the registry. Protects the registry from accidental overwrites. Reservation counts for `published`, `blocked` **and** invalid intakes (L-2). |

**Gate mode (locked, L-1):** default `GATE_MODE=consumer` — block when a finding breaks a *known consumer* or is a *past-sunset removal*; unconsumed public breaking changes publish with a loud recorded warning. `strict` (block any breaking diff) remains available via env. With this kit the publish/block outcome is identical under both modes; only the reason list differs.

## 4. Tech stack (locked)

| Layer | Choice |
|---|---|
| Runtime | Node.js (modern LTS) |
| Framework | Express |
| Language | TypeScript |
| Database | SQLite via **`better-sqlite3`** (sync API; gate verdict + status write + audit row commit in one transaction) |
| YAML parsing | `js-yaml` |
| Parsing/diff | **Custom differ** — we resolve internal `$ref`s ourselves so a broken ref (`ClaimDocumnt`) becomes a reported finding, not a crash; deterministic rulebook |
| Tests | `vitest` + `supertest` (golden-file tests over all 12 specs + end-to-end webhook assertion) |
| Dashboard UI | **React + Vite + Tailwind CSS** SPA in `contract-guard/client/` (icons: `lucide-react`). Built to static assets in `client/dist`, served by Express at `GET /`; dev mode runs on the Vite dev server proxying `/api` to the app. *(PO instruction 2026-11-18 — replaces the earlier server-rendered HTML template; supersedes T-5's "basic HTML" note in DECISIONS.md.)* |
| App location | `contract-guard/` at repo root; reads the kit via `KIT_ROOT` (default: repo root). Nothing writes into `specs/` or `consumers/`, ever. |

**Env config:** `PORT` (app), `WEBHOOK_URL` (default `http://localhost:9900`), `CG_DB_PATH`, `CG_AS_OF_DATE` (pins "today"; acceptance runs use `2026-11-18`), `GATE_MODE` (default `consumer`), `CG_FRESH` (default `1` — replay pipeline on startup).

## 5. Architecture

```
specs/ ─┐                        ┌─→ Diff engine ──┐
        ├→ Loader → Validator ─→ │                 ├→ Publication Gate ─→ block/publish
consumers/ ┘   (refs, dupes)     │ Wire Index ─────┤                    └→ Notifier → webhook :9900
                                 │ Consumer Index ─┘
                                 └ SQLite (services, versions, findings, alerts, events)
```

- **Loader** — walks `specs/*/`, orders by numeric filename prefix; `info.version` is truth (never the filename). Read-only.
- **Validator** — resolves internal `$ref`s; findings for dangling refs, duplicate `operationId`, duplicate path+method. A validity error is its own block reason (distinct from breaking).
- **Wire Index** — flattens every operation into wire field paths (`premium.breakdown[].amount`) with type, requiredness, enum, `deprecated`, `x-sunset` — resolved through refs, independent of component names. This is why quote-api 1.1.0 (schema renames, inlined objects) scores **zero** findings.
- **Path normalization** — `{id}` and `{quoteId}` both normalize to `/quotes/{}`; param renames produce an alias map (`id`→`quoteId`) applied when resolving consumer `sends`, avoiding false alarms.
- **Diff engine** — previous *published* version → candidate. Baseline never includes blocked versions.
- **Consumer impact engine** — matches `consumer_use` by (provider, method, normalized path); checks `sends`/`reads` (dots for nesting, `[]` for array items) against the candidate's wire index; `sends` resolves against body fields *and* parameters.
- **Sunset engine** — date-driven; overdue sunsets still in use + advance notices for future ones; runs at startup and on `POST /api/recheck`.
- **Publication Gate** — `allow | block`; on block the version is stored as `blocked` with reason codes, an audit event is written, alerts dispatched.
- **Notifier** — POSTs JSON to `WEBHOOK_URL`; one summary per blocked publication + one message per affected consumer; retries with backoff; every attempt recorded in `alerts`; never crashes the gate.

**SQLite tables:** `services`, `spec_versions` (status, content hash, source file), `operations` (+`is_internal`, normalized path), `wire_fields` (operation, direction, status code, path, type, required, enum JSON, deprecated, sunset), `consumers`, `consumer_uses`, `consumer_use_fields`, `findings`, `alerts`, `events`.

## 6. Classification rulebook

| Change | Direction | Verdict |
|---|---|---|
| Response field removed / removed from `required` | reads | 🔴 breaking |
| Response field added | reads | 🟢 additive |
| Request field added as `required` | sends | 🔴 breaking for consumers that don't send it |
| Request field removed | sends | 🔴 breaking if a consumer sends it |
| Request field made optional | sends | 🟢 safe |
| Enum value removed | sends | 🔴 breaking if a consumer sends that field |
| Enum value added | reads | 🟡 warning (exhaustive-switch risk) |
| Type/format change | both | 🔴 breaking |
| Operation removed, or new required param | both | 🔴 breaking (skipped if `x-internal`) |
| Schema/component renamed, identical wire shape | both | ⚪ refactor — **no finding** |
| Path param renamed, same template shape | both | ⚪ refactor + alias recorded |
| Deprecated field removed, sunset passed | both | ⛔ hard-breaking regardless of consumers |

## 7. Acceptance matrix — the 12 kit files (target state)

Publish order = filename order per service; baseline = last **published** version.
**Totals: 5 published ✅ / 6 blocked ⛔ / 1 rejected 🚫.**

| # | File | Version | Outcome | Reason |
|---|---|---|---|---|
| 1 | `specs/quote-api/1-initial.yaml` | 1.0.0 | ✅ published | first version |
| 2 | `specs/quote-api/2-reorganised.yaml` | 1.1.0 | ✅ published | pure refactor (param rename `id`→`quoteId`, schemas inlined/renamed) — zero wire change, zero findings |
| 3 | `specs/quote-api/3-price-lines.yaml` | 2.0.0 | ⛔ blocked | `premium.breakdown[].amount` → `value` breaks **mobile-app**. New required `region` param sits on `x-internal` op → noted, not blocking |
| 4 | `specs/quote-api/4-ncb-and-taxes.yaml` | 2.1.0 | ⛔ blocked | additive `rider.ncbPercent` / `premium.taxes`, **but** still carries the `amount`→`value` rename vs baseline 1.1.0 (cascade) |
| 5 | `specs/policy-api/1-initial.yaml` | 1.0.0 | ✅ published | first version |
| 6 | `specs/policy-api/2-deprecations.yaml` | 1.1.0 | ✅ published | deprecations only → sunset notices emitted. `legacyCode` sunset `2026-11-01` already overdue and **payments-svc** reads it |
| 7 | `specs/policy-api/3-remove-old-fields.yaml` | 2.0.0 | ⛔ blocked | removes `legacyCode` (past sunset, read by payments-svc) → hard-breaking. Removes `holder.phone` (sunset `2027-06-30`, no consumer) → warning under `consumer` gate |
| 8 | `specs/policy-api/4-endorsement-rules.yaml` | 2.1.0 | ⛔ blocked | new required `requestedBy` + enum drops `VEHICLE` breaks **partner-portal**; still lacks `legacyCode` vs baseline 1.1.0 |
| 9 | `specs/claims-api/1-initial.yaml` | 1.0.0 | ✅ published | first version |
| 10 | `specs/claims-api/2-channel-and-notes.yaml` | 1.1.0 | ⛔ blocked | **invalid spec**: dangling `$ref` `#/components/schemas/ClaimDocumnt` |
| 11 | `specs/claims-api/3-channel-and-notes-fixed.yaml` | 1.1.0 | 🚫 rejected | duplicate version number (rule 5) — correct message: "publish this as 1.1.1" |
| 12 | `specs/claims-api/4-approval-later.yaml` | 2.0.0 | ⛔ blocked | `amountApproved` dropped from `required` (field still exists) — read by **mobile-app** |

**Exposed consumers at end state:** mobile-app (2 issues), payments-svc (1 overdue sunset), partner-portal (1 blocked-ahead), notifications-svc (clean).

## 8. Alert design (webhook receiver, `:9900`)

| Path | Fires when |
|---|---|
| `/alerts/block/{service}/{version}` | publication blocked (summary + owner) |
| `/alerts/consumer/{consumer}` | one message per affected consumer/team — "your call breaks" |
| `/alerts/deprecation/{service}/{version}` | field newly deprecated, with sunset date |
| `/alerts/sunset-overdue/{service}` | sunset passed, field still present and still consumed |
| `/alerts/invalid-spec/{service}/{version}` | spec failed validation |
| `/alerts/rejected/{service}/{version}` | duplicate version at intake |

Payload sketch: `{ event, service, owner, from_version, to_version, action, verdict, findings[], spec_file, as_of, occurred_at }`.

## 9. HTTP API + UI

- `GET /api/health` · `GET /api/services` · `GET /api/services/:name/versions` · `GET /api/services/:name/versions/:v` · `.../impact`
- `POST /api/services/:name/versions/:v/publish` (re-run gate live) · `POST /api/specs` (manual upload, still validated + deduped)
- `GET /api/consumers` · `GET /api/consumers/:name/risks` · `GET /api/findings` · `GET /api/alerts` · `GET /api/events` · `POST /api/recheck`
- `GET /` — React dashboard (Vite + Tailwind SPA from `client/dist`): stats overview (services, risks, blocked specs, alert status), per-service version timeline (published/blocked/rejected), findings + impact inspector tables, live alert feed, re-publish actions.

## 10. Build sequence (each phase independently testable)

| Phase | Deliverable |
|---|---|
| 0 | Scaffold: TS + Express + config/env + logger + SQLite init/migrations (`contract-guard/`) |
| 1 | Loader + validator (dangling refs, dup ops) → registry rows |
| 2 | Wire index + path normalization + consumer index |
| 3 | Diff engine + classification rulebook |
| 4 | Consumer impact engine |
| 5 | Publication gate (baseline = last published, statuses, audit) |
| 6 | Notifier + alert log + retries |
| 7 | Startup pipeline: auto-load → auto-publish in order → sunset scan |
| 8 | HTTP API + dashboard UI (read + publish actions) |
| 9 | Acceptance tests vs §7 matrix + end-to-end webhook assertion + demo README |

## 11. Resolved items (were open during planning — now locked)

- [x] **Restart semantics** → `CG_FRESH=1` default: every startup replays the pipeline (loads, publishes, re-alerts); prior runs retained as DB audit history and never used to skip the replay. See L-3.
- [x] **Finding codes + messages vocabulary** → canonical 13-code vocabulary (`ERR_*` blocking / `WARN_*` warning / info) defined in `IMPLEMENTATION_PLAN.md` §"Canonical finding codes"; new codes follow the same convention. See L-6.
- [x] **Webhook payload schema + paths** → the §8 paths and payload shape, POSTed to `WEBHOOK_URL` (default `http://localhost:9900`). See L-6.
- [x] **Gate policy (consumer vs strict)** → `GATE_MODE=consumer` default: block on known-consumer impact or past-sunset removal; unconsumed public breaking changes publish with warnings; `x-internal` ops skipped. `strict` stays available via env. See L-1.
- [x] **Version reservation semantics** → published, blocked and invalid intakes all reserve `info.version`; a later file reusing it is rejected `ERR_DUPLICATE_VERSION` ("publish as 1.1.1"). See L-2.
- [x] **Test date for the matrix** → `CG_AS_OF_DATE=2026-11-18` pinned for acceptance runs, making `legacyCode` (sunset `2026-11-01`) overdue. See L-4.
- [x] **Enum impact wording** → conservative: removing an enum option on a field a consumer sends is breaking, reported as possible-usage rather than proven. See L-5.
