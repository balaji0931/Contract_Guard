# Contract Guard

**The API contract registry that stands between providers and their consumers — no spec publishes unless every known consumer survives it.**

Provider teams ship OpenAPI specs for shared services (`quote-api`, `policy-api`, `claims-api`); four downstream services (`mobile-app`, `partner-portal`, `payments-svc`, `notifications-svc`) call them. Today a provider can silently rename a response field, drop an enum option, or delete a field consumers still read, and the breakage surfaces in production. Contract Guard automates prevention: every publication is validated, diffed at the wire level, checked against consumer manifests, **gated** (published / blocked / rejected), audited in SQLite, and announced to a webhook receiver.

---

## Table of contents

1. [The problem](#the-problem)
2. [The solution](#the-solution)
3. [Architecture: the automated pipeline](#architecture-the-automated-pipeline)
4. [Locked decisions (L-1 … L-6)](#locked-decisions-l-1--l-6)
5. [Finding codes](#finding-codes-canonical-vocabulary-l-6)
6. [Acceptance matrix (expected results)](#acceptance-matrix-expected-results-on-this-kit)
7. [Tech stack](#tech-stack)
8. [Project structure](#project-structure)
9. [Setup and configuration](#setup-and-configuration)
10. [Running](#running)
11. [HTTP API](#http-api)
12. [Webhook alerts](#webhook-alerts)
13. [Dashboard (React + Vite + Tailwind)](#dashboard-react--vite--tailwind)
14. [Testing](#testing)
15. [Guarantees and constraints](#guarantees-and-constraints)
16. [Documentation map](#documentation-map)

---

## The problem

Teams publish OpenAPI specifications for shared APIs while consumer services depend on them. Nothing currently stands between the two. A provider can publish a spec that silently breaks a consumer:

- a **renamed response field** (`premium.breakdown[].amount` → `value`) — the mobile app renders `undefined`;
- a **removed enum option** (`VEHICLE` dropped from endorsement `type`) — the partner portal's request is now invalid;
- a **newly required request field** (`requestedBy`) — the partner portal never sends it and starts getting 400s;
- a **deleted field consumers still read** (`legacyCode`, past its sunset date, still read by payments) — the payments service crashes downstream.

None of these are caught by tooling that only validates a spec against the OpenAPI schema: the spec is *syntactically fine*; the damage is **semantic and cross-service**.

## The solution

Contract Guard ingests the providers' specs and the consumers' manifests and sits on the publish path:

1. It understands **what crossed the wire** in each version — flattened field paths, types, requiredness, enums, deprecation and sunset markers — independent of schema component names. Pure refactors (renamed schemas, inlined objects) produce **zero findings**.
2. It knows **which consumers call which operations, what they send, and what they read** (declared in the read-only `consumers/` manifests).
3. Every publication attempt is **diffed against the last published version**, and each breaking change is **attributed to concrete impacted consumers**.
4. The **publication gate** blocks anything that breaks a known consumer or removes a past-sunset field; clean versions publish; suspicious-but-unconsumed changes publish with recorded warnings.
5. Every verdict, finding and alert is **auditable in SQLite**, and **webhook alerts** tell owners and consumer teams exactly what broke and why — before it ships.

---

## Architecture: the automated pipeline

The full pipeline runs **automatically at every startup** (`CG_FRESH=1` default, decision L-3), on re-check (`POST /api/recheck`), and for manual uploads (`POST /api/specs`). Nothing is manual; nothing trusts filenames for identity.

```
 specs/*.yaml ──► ① discovery ──► ② load + validate ──► ③ wire indexing
 consumers/*.yaml ─► (same)                                   │
                                                               ▼
        events + alerts ◄── ⑦ notifications ◄── ⑥ publication gate ◄── ⑤ impact analysis
                                   │                    │
                                   ▼                    ▼
                          webhook receiver        registry (SQLite)
                          (localhost:9900)        verdicts · findings · audit
                                                          │
                                                          ▼
                                                 ⑧ sunset engine → WARN_SUNSET_OVERDUE
```

| Stage | What happens | Where |
|---|---|---|
| **① Discovery** | Scan `specs/<service>/*.yaml` (numeric filename prefix = the owner team's intended publication order) and `consumers/*.yaml`. Files are opened **read-only**, always. | `src/loader/discovery.ts`, `src/loader/readFile.ts` |
| **② Load + validate** | Parse YAML (`js-yaml`), take the identity from `info.version` (never the filename), resolve internal `$ref`s, and validate. A dangling ref (e.g. `#/components/schemas/ClaimDocumnt`) becomes a finding `ERR_INVALID_SPEC`, not a crash. Content hash recorded. | `src/loader/specLoader.ts`, `src/validator/specValidator.ts` |
| **③ Wire indexing** | Flatten every operation into **wire field paths** (`premium.breakdown[].amount`, params first, then request body; responses grouped by status code) with type, format, requiredness, enum values, `deprecated`, `x-sunset`. Component names are irrelevant — only the wire shape survives. Path templates are normalized (`{id}` ≡ `{quoteId}`) with an alias map so renames don't confuse consumer matching. Persisted to `operations` / `wire_fields`. | `src/wire/schemaWalker.ts`, `src/wire/operationIndex.ts`, `src/wire/aliases.ts`, `src/registry/wireStore.ts` |
| **④ Semantic diff** | Diff candidate vs **baseline = the last *published* version** (blocked/rejected versions never become baseline). Rulebook → canonical finding codes (below): removed field → blocking; required→optional; new required request field; enum value removed (with consumer-usage context); type changed; operation removed; past-sunset removal (`ERR_SUNSET_REMOVAL_EXPIRED`, L-4); new deprecations (`WARN_DEPRECATED_FIELD` with sunset date); new enum values → warning; changes on `x-internal` operations are noted, not blocking. | `src/diff/wireDiff.ts`, `src/diff/baseline.ts` |
| **⑤ Consumer impact analysis** | Attribute each blocking finding to concrete consumers: match the manifest's `provider/method/path` to the operation, resolve `sends`/`reads` through the alias map, then apply per-code direction rules (removed/optionalized/type-changed → whoever reads or sends it; now-required → whoever *doesn't* send it; enum removal → conservative possible-usage match, L-5; operation removed → every caller). `x-internal` operations are excluded entirely (PO rule L-1). | `src/impact/consumerImpact.ts`, `src/consumers/consumerIndex.ts` |
| **⑥ Publication gate** | Decide **published / blocked / rejected** in **one SQLite transaction**: version reservation first (L-2 — a number already reserved by a published/blocked/invalid intake is `rejected` with `ERR_DUPLICATE_VERSION` and "publish this as 1.1.1" guidance), then validity, then the L-1 gate over diff + impacts. Status, reason codes, all findings (with `consumer_id` attribution) and one `gate_decision` audit event commit atomically — a failure at any point rolls all of it back. | `src/gate/publicationGate.ts` |
| **⑦ Notifications** | §8 webhook alerts POSTed as JSON to `WEBHOOK_URL` *after* the gate transaction commits: block summary (+ owner), one message per impacted consumer ("your call breaks"), deprecation notice with sunset dates, sunset-overdue, invalid-spec, rejected-version. Retries with exponential backoff; every attempt persisted in `alerts`. **Delivery failure can never change a verdict.** | `src/notify/notifier.ts` |
| **⑧ Sunset engine** | Date-driven checks over what is *published*: `x-sunset` due (L-4: passed **or** equal to the pinned as-of date) and a known consumer still reads/sends the field → `WARN_SUNSET_OVERDUE` findings + `/alerts/sunset-overdue/{service}`. Runs at startup and on re-check. | `src/sunset/sunsetEngine.ts`, `src/pipeline/startup.ts` |

The **dashboard** and **HTTP API** read the same registry; the re-publish action re-runs stage ⑥ with the identical engine — HTTP can never bypass blocking or duplicate rules.

---

## Locked decisions (L-1 … L-6)

Resolved with the product owner and locked in `IMPLEMENTATION_PLAN.md`; they govern all behavior:

| ID | Topic | Rule |
|---|---|---|
| **L-1** | Gate policy | `GATE_MODE=consumer` is the default. **Block** when a change breaks a **known consumer** or is a **past-sunset field removal**. Unconsumed public breaking changes **publish with recorded warnings** (`WARN_UNCONSUMED_BREAKING`). `x-internal` operations skip consumer-impact checks entirely (still parsed, validated, listed). `GATE_MODE=strict` (block on any breaking finding) remains available via env. |
| **L-2** | Version reservation | Any intake that occupies a version number **reserves it** — published, blocked and invalid intakes all count. A later file with the same `info.version` is **rejected** with `ERR_DUPLICATE_VERSION` and guidance to publish the next number (the corrected claims file → "publish as 1.1.1"). |
| **L-3** | Restart behavior | `CG_FRESH=1` by default: **every startup replays the full pipeline** (loads, publishes, re-alerts) so demos show live blocking and receiver traffic. Prior runs are retained in DB audit history (`events`, `alerts`) and are **never** used to dedupe or skip the replay. |
| **L-4** | Sunset handling | `CG_AS_OF_DATE` pins "today"; the pinned acceptance run uses **`2026-11-18`**, making `legacyCode` (sunset `2026-11-01`) overdue. Removing a field whose sunset is **passed** is a hard block regardless of consumers. Removing one whose sunset is **still future** (`holder.phone`, `2027-06-30`) is a warning, not a block, under L-1. Sunset dates compare as **IST calendar dates**; equality with the as-of date counts as due. |
| **L-5** | Enum impact | A manifest that names an enum field without listing values gets the **conservative** verdict: removing an enum option from a field that consumer sends is a breaking finding (partner-portal sends `type` → dropping `VEHICLE` breaks it). The finding text states it is a **possible-usage match, not proof**. |
| **L-6** | Codes and payloads | Finding codes come from the canonical vocabulary below; new codes follow the same `ERR_`/`WARN_` convention. All alerts POST JSON to `WEBHOOK_URL` (default `http://localhost:9900`) using the paths and payload shape in `PLAN.md` §8. |

---

## Finding codes (canonical vocabulary, L-6)

| Code | Severity | Meaning |
|---|---|---|
| `ERR_BREAKING_FIELD_REMOVED` | blocking | Request/response field no longer exists |
| `ERR_BREAKING_FIELD_NOW_OPTIONAL` | blocking | Response field removed from `required` (may now be absent) |
| `ERR_BREAKING_FIELD_NOW_REQUIRED` | blocking | Request field/param added or made required |
| `ERR_BREAKING_ENUM_VALUE_REMOVED` | blocking | Enum option removed from a field a consumer sends (L-5) |
| `ERR_BREAKING_TYPE_CHANGED` | blocking | Field type or format changed |
| `ERR_BREAKING_OPERATION_REMOVED` | blocking | Path+method a consumer calls is gone |
| `ERR_SUNSET_REMOVAL_EXPIRED` | blocking | Deprecated field removed on/after its `x-sunset` date (L-4) |
| `ERR_INVALID_SPEC` | blocking | Spec failed validation (e.g. unresolved `$ref`) |
| `ERR_DUPLICATE_VERSION` | intake_reject | `info.version` already reserved (L-2) |
| `WARN_DEPRECATED_FIELD` | warning | Field newly `deprecated: true`, with sunset date |
| `WARN_SUNSET_OVERDUE` | warning | Sunset passed, field still present and still consumed |
| `WARN_UNCONSUMED_BREAKING` | warning | Breaking diff with no known consumer impact (publishes under L-1) |
| `WARN_ENUM_VALUE_ADDED` | warning | New enum option on a returned field (exhaustive-switch risk) |
| `WARN_INTERNAL_CHANGE_NOTED` | info | Change on an `x-internal` operation, excluded from the gate |

---

## Acceptance matrix (expected results on this kit)

With `CG_AS_OF_DATE=2026-11-18`, `GATE_MODE=consumer`, an empty database, and the unmodified kit, the startup pipeline decides all 12 files:

| # | File | Version | Outcome | Why |
|---|---|---|---|---|
| 1 | `quote-api/1-initial.yaml` | 1.0.0 | ✅ published | first version |
| 2 | `quote-api/2-reorganised.yaml` | 1.1.0 | ✅ published | pure refactor (param `id`→`quoteId`, schemas renamed/inlined) — zero wire change, zero findings |
| 3 | `quote-api/3-price-lines.yaml` | 2.0.0 | ⛔ blocked | `premium.breakdown[].amount` → `value` breaks **mobile-app**; new required `region` sits on an `x-internal` op → noted, not blocking |
| 4 | `quote-api/4-ncb-and-taxes.yaml` | 2.1.0 | ⛔ blocked | additive fields, but still carries the `amount` rename vs baseline 1.1.0 (a blocked version never becomes baseline) |
| 5 | `policy-api/1-initial.yaml` | 1.0.0 | ✅ published | first version |
| 6 | `policy-api/2-deprecations.yaml` | 1.1.0 | ✅ published | deprecations only → sunset notices; `legacyCode` sunset `2026-11-01` already overdue and read by **payments-svc** |
| 7 | `policy-api/3-remove-old-fields.yaml` | 2.0.0 | ⛔ blocked | removes `legacyCode` past sunset → hard block; `holder.phone` removal (future sunset, no consumer) → warning |
| 8 | `policy-api/4-endorsement-rules.yaml` | 2.1.0 | ⛔ blocked | new required `requestedBy` + enum drops `VEHICLE` breaks **partner-portal** (L-5); still lacks `legacyCode` |
| 9 | `claims-api/1-initial.yaml` | 1.0.0 | ✅ published | first version |
| 10 | `claims-api/2-channel-and-notes.yaml` | 1.1.0 | ⛔ blocked | **invalid spec**: dangling `$ref` `ClaimDocumnt` |
| 11 | `claims-api/3-channel-and-notes-fixed.yaml` | 1.1.0 | 🚫 rejected | duplicate version number (L-2) — "publish this as 1.1.1" |
| 12 | `claims-api/4-approval-later.yaml` | 2.0.0 | ⛔ blocked | `amountApproved` becomes optional → breaks **mobile-app** |

**Totals: 5 published · 6 blocked · 1 rejected.** End-state exposure: mobile-app (2 issues), payments-svc (1), partner-portal (1), notifications-svc (clean).

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js ≥ 22 (modern LTS) | matches `engines` |
| API framework | **Express 5** + **TypeScript** (strict) | ubiquitous, typed across the domain model |
| Database | **SQLite via `better-sqlite3`** | synchronous API → the gate's verdict + findings + audit commit in **one real transaction**; zero ops |
| YAML | **`js-yaml`** | with our own `$ref` resolver so broken refs become findings, not crashes |
| Diffing | **Custom wire-level differ** | deterministic rulebook; component-name independence is the point |
| Tests | **vitest + supertest** | unit + end-to-end HTTP + real webhook receipt assertions |
| Dashboard | **React + Vite + Tailwind CSS** (+ `lucide-react`) | SPA in `contract-guard/client/` (PO instruction 2026-11-18, supersedes T-5's plain HTML) |
| Receiver | Python stdlib server (kit file, unmodified) via **docker-compose** (which now runs the full stack) | stands in for chat/email/paging |

---

## Project structure

```
.
├── specs/                    ← READ-ONLY provider specs (never opened for writing, ever)
│   ├── quote-api/            1-initial.yaml … 4-ncb-and-taxes.yaml
│   ├── policy-api/           1-initial.yaml … 4-endorsement-rules.yaml
│   └── claims-api/           1-initial.yaml … 4-approval-later.yaml
├── consumers/                ← READ-ONLY consumer manifests (mobile-app, partner-portal,
│                                payments-svc, notifications-svc)
├── webhook-receiver/         ← kit's stand-in for chat/email (Dockerfile + app.py, unmodified)
├── docker-compose.yml        ← one command runs everything: receiver (:9900) + contract-guard (:5051)
├── contract-guard/           ← ALL application code lives here
│   ├── Dockerfile            ← multi-stage: builds dashboard + backend, ships runtime only
│   ├── src/
│   │   ├── loader/           discovery, read-only file IO, spec/consumer intake
│   │   ├── validator/        structural validation, $ref resolution
│   │   ├── wire/             schema walker, operation index, path aliases
│   │   ├── registry/         intake store, wire store (SQLite persistence)
│   │   ├── diff/             wire diff rulebook, baseline selection
│   │   ├── impact/           consumer-impact attribution engine
│   │   ├── gate/             publication gate (atomic verdict + audit)
│   │   ├── notify/           §8 webhook notifier with retry/backoff
│   │   ├── sunset/           sunset-overdue engine
│   │   ├── pipeline/         startup pipeline (stages ①–⑧), kit loader/indexer
│   │   ├── api/              HTTP API routes, upload ingestion, dashboard state
│   │   ├── db/               database + migrations
│   │   └── server.ts         entry point
│   ├── client/               ← React + Vite + Tailwind dashboard
│   │   └── src/components/   StatsOverview · ServiceTimeline · FindingsInspector ·
│   │                         ImpactInspector · AlertFeed
│   └── test/                 vitest suites, one per build phase
├── PLAN.md                   ← locked architecture plan (§1–§10)
├── DECISIONS.md              ← locked decision log (PO-1…PO-5, D-1…D-7, T-1…T-5)
├── IMPLEMENTATION_PLAN.md    ← locked roadmap (L-1…L-6, phase table)
└── PROGRESS.md               ← phase-by-phase status with commits
```

> **Boundary guarantee:** nothing outside `contract-guard/` is ever written. `specs/` and `consumers/` are read via read-only file handles, and every phase verification recomputes the kit's content fingerprint (`find specs consumers -type f | sort | shasum -a 256 | shasum -a 256`) to prove zero drift.

---

## Setup and configuration

### Recommended: Docker (zero-config, one command)

**Evaluators do not need Node or Python installed.** Docker (or Podman) is the only
prerequisite — everything else (dashboard build, backend compile, SQLite,
migrations, the full pipeline replay, live alerts) happens inside containers:

```bash
docker compose up --build          # add -d to run detached
```

Within seconds you have the entire Contract Guard system live:

| Service | URL | What it is |
|---|---|---|
| **contract-guard** | <http://localhost:5051> | React + Tailwind dashboard at `/`, full JSON API under `/api/*` |
| **webhook-receiver** | <http://localhost:9900> | Alert receiver UI (auto-refreshing); `GET /api/received` as JSON, `DELETE /api/received` to clear |

On startup the `contract-guard` container automatically:

1. opens `specs/` and `consumers/` **read-only** (mounted at `/kit` with Docker's `:ro` flag — the read-only law is enforced by the mount itself);
2. applies SQLite migrations (DB kept in the `contract-guard-data` volume);
3. replays the entire pipeline — discovery → validation → wire indexing → diff →
   consumer impact → gate (5 published / 6 blocked / 1 rejected) → sunset engine;
4. POSTs all §8 webhook alerts to the receiver, which displays them live.

The acceptance settings are **baked into `docker-compose.yml`**, so the demo behaves
identically on every machine with zero configuration: `CG_FRESH=1` (full replay
every start, L-3), `CG_AS_OF_DATE=2026-11-18` (pinned "today", L-4),
`GATE_MODE=consumer` (L-1), plus `WEBHOOK_URL` pointed at the receiver service and
`PORT=5051`. Ports are overridable if taken:

```bash
CG_PORT=6051 WEBHOOK_PORT=9950 docker compose up --build
```

Useful follow-ups:

```bash
docker compose logs -f contract-guard   # watch the pipeline: 12 gate decisions + 16 alerts
docker compose down                     # stop (audit history kept in the volume)
docker compose down -v                  # stop AND wipe the DB → next up is a clean run
```

> Port 9900 is published for you to browse; inside the network the app talks to the
> receiver at `webhook-receiver:9000`, so alerts never depend on host port mapping.

### Alternative: manual local setup (Node.js ≥ 22 + Python 3)

Prefer running processes on your machine? Node ≥ 22 (tested on 24) plus Python 3:

```bash
# 1. webhook receiver on :9900 (plain stdlib, no pip install needed)
cd webhook-receiver && PORT=9900 python3 app.py        # in one terminal

# 2. install dependencies
cd ../contract-guard
npm install                 # backend
cd client && npm install    # dashboard
cd ..

# 3. build and start (API + dashboard on one port)
npm run build
cd client && npm run build && cd ..                   # dashboard → client/dist
PORT=5051 WEBHOOK_URL=http://localhost:9900 \
CG_AS_OF_DATE=2026-11-18 GATE_MODE=consumer CG_FRESH=1 \
node dist/server.js
```

Then <http://localhost:5051> (dashboard) and <http://localhost:9900> (receiver) work
exactly as in the Docker flow. (The env vars below already have sane defaults; the
ones listed here reproduce the compose/acceptance configuration.)

### Configuration (env / `.env`) — reference

All settings come from the environment. In the Docker flow they are already set in
`docker-compose.yml`; you only need them for manual runs. With Node ≥ 22 you can
keep them in `contract-guard/.env` and pass the file in (the app deliberately has
no dotenv dependency):

```bash
# contract-guard/.env (manual runs; `node --env-file=.env dist/server.js`)
PORT=5051                       # compose default 5051; app default when unset is 5000
WEBHOOK_URL=http://localhost:9900
CG_DB_PATH=data/contract-guard.db
CG_AS_OF_DATE=2026-11-18      # pin "today" (acceptance runs pin this)
GATE_MODE=consumer            # consumer (default) | strict
CG_FRESH=1                    # 1 (default) = replay pipeline every startup
KIT_ROOT=..                   # folder containing specs/ and consumers/
CG_LOG_LEVEL=info             # debug | info | warn | error
```

| Variable | Default (standalone) | In compose | Purpose |
|---|---|---|---|
| `PORT` | `5000` | `5051` | HTTP port for the API + dashboard |
| `WEBHOOK_URL` | `http://localhost:9900` | `http://webhook-receiver:9000` | alert receiver base URL |
| `CG_DB_PATH` | `contract-guard/data/contract-guard.db` | `/app/data/contract-guard.db` (named volume) | SQLite file (`:memory:` supported for tests) |
| `CG_AS_OF_DATE` | real date (IST calendar day) | `2026-11-18` | pins sunset math; acceptance pins `2026-11-18` |
| `GATE_MODE` | `consumer` | `consumer` | L-1 gate policy |
| `CG_FRESH` | `1` | `1` | L-3 pipeline replay on startup |
| `KIT_ROOT` | parent of `contract-guard/` | `/kit` (read-only mount) | where `specs/` and `consumers/` live |
| `CG_LOG_LEVEL` | `info` | `info` | logger verbosity |

Bad values abort startup with a precise list of problems (`ConfigError`) — the app never guesses.

### Database migrations — automatic

**None to run manually, in either mode.** `openDatabase()` applies pending migrations from `src/db/migrations.ts` at startup, inside a transaction, and records them in `schema_migrations`. Current status is exposed by `GET /api/health` (`db.pending` must be `[]`). Tables: `services`, `spec_versions`, `operations`, `wire_fields`, `consumers`, `consumer_uses`, `consumer_use_fields`, `findings`, `alerts`, `events`, plus the migration ledger.

---

## Running

### With Docker (recommended)

`docker compose up --build` — see [Setup and configuration](#setup-and-configuration).
Watch the story unfold:

```bash
docker compose logs -f contract-guard
# … startup pipeline complete published=5 blocked=6 rejected=1 sunsetOverdue=1 alertsSent=16 alertsFailed=0
```

Then open <http://localhost:5051> (dashboard: timelines, findings, impact, live
alert feed) and <http://localhost:9900> (receiver: every §8 block/consumer/
deprecation/invalid/rejected/sunset alert). Health check:
`curl http://localhost:5051/api/health`.

Replay the demo as often as you like — L-3 means **every start replays the whole
pipeline and re-fires all alerts**, and prior runs stay in the volume's audit
history (`events`, `alerts`). For a pristine run: `docker compose down -v`.

### Manually (Node.js + Python)

```bash
cd contract-guard

# Production-style: build backend + dashboard, then serve both from one process
npm run build
(cd client && npm run build)
node --env-file=.env dist/server.js        # or: npm start (with exported env)

# Dev mode (hot reload)
npm run dev                                # backend with tsx watch
cd client && npm run dev                   # Vite on :5173 with HMR, /api proxied
```

On startup you will see the same L-3 replay: config banner → migrations →
discovery → validation (`ERR_INVALID_SPEC` for the broken claims file) → wire
indexing → per-file `gate decision` log lines → alert deliveries.

Replay locally by deleting the DB (`rm data/contract-guard.db`) or just restart —
either way the full publish/block/alert story runs again.

> **macOS note (manual mode):** Control Center (AirPlay Receiver) listens on port
> 5000 and will hold it (`EADDRINUSE`). The Docker default (5051) sidesteps this;
> for manual runs set `PORT=5051` (and keep `client/vite.config.ts`'s proxy in
> sync via `CG_API_TARGET`), or disable AirPlay's Receiver in System Settings.

---

## HTTP API

All endpoints are JSON; errors return `{ "error": "<code>", ... }` with proper status codes.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | status, migration state, gate mode, pinned as-of date |
| `GET /api/services` | services with owner, latest published, per-status counts |
| `GET /api/services/:name/versions` | every intake with status + reason codes (file order) |
| `GET /api/services/:name/versions/:v` | all attempts for that number with findings |
| `GET /api/services/:name/versions/:v/impact` | per-consumer attribution: who breaks, which call, which field |
| `POST /api/services/:name/versions/:v/publish` | **re-runs the gate live** — cannot bypass blocking or L-2 |
| `POST /api/specs` | manual upload `{service, yaml}` — validated, deduped, gated like kit files |
| `GET /api/consumers` · `GET /api/consumers/:name/risks` | tracked consumers, usage, exposure |
| `GET /api/findings?service=&version=&code=&severity=&consumer=` | registry-wide findings |
| `GET /api/alerts?limit=` · `GET /api/events?kind=&limit=` | delivery log + audit trail |
| `POST /api/recheck` | re-runs the sunset engine and retries failed alerts |

---

## Webhook alerts

Every alert is a JSON POST (`PLAN.md` §8) with payload `{ event, service, owner, from_version, to_version, action, verdict, findings[], spec_file, as_of, occurred_at }` (consumer alerts add `consumer`, `team`). Delivery uses `fetch` with timeout, exponential-backoff retries, and full attempt logging in the `alerts` table. Delivery failure **never** changes a verdict.

| Path | Fires when |
|---|---|
| `/alerts/block/{service}/{version}` | publication blocked (summary + owner) |
| `/alerts/consumer/{consumer}` | one message per affected consumer — "your call breaks" |
| `/alerts/deprecation/{service}/{version}` | field newly deprecated, with sunset date |
| `/alerts/sunset-overdue/{service}` | sunset passed, field still present and still consumed |
| `/alerts/invalid-spec/{service}/{version}` | spec failed validation |
| `/alerts/rejected/{service}/{version}` | duplicate version number at intake |

---

## Dashboard (React + Vite + Tailwind)

A production-grade SPA in `contract-guard/client/` (React 19, Vite 7, Tailwind CSS 4, `lucide-react` icons) that talks exclusively to the documented JSON API:

- **Stats overview** — services, exposed consumers, blocked versions, open consumer issues, alert health.
- **Version timelines** — per service, every intake with `published` / `blocked` / `rejected` badges, reason codes, source file.
- **Findings inspector** — searchable/filterable findings table (severity chips, operation, field, consumer).
- **Impact inspector** — click any version or finding: statuses, blocking reason codes, and per-consumer issue cards ("who breaks · which call · which field · why").
- **Live alert feed** — §8 deliveries with status, attempts, HTTP code and timestamp, refreshed every 5 s.
- **Actions** — per-version **re-publish** (re-runs the gate and renders the verdict inline) and **Run recheck** (sunset engine + alert retries).

Build and serve (the Express server serves `client/dist` at `/`):

```bash
cd contract-guard/client && npm run build    # tsc --noEmit && vite build
# GET http://localhost:5051/ (compose default) now serves the dashboard
```

Before a client build, `GET /` returns a clear "assets not built" notice instead of a 404.

---

## Testing

```bash
cd contract-guard
npm test                # vitest run — full suite
npm run test:watch      # watch mode
npm run typecheck       # tsc --noEmit (backend)
npm run build           # production build
```

The suite (one file per build phase, currently **186 tests / 15 files**) covers, among others:

- loading/validation of all 12 specs (dangling `$ref` → `ERR_INVALID_SPEC`), consumer manifest parsing;
- wire-index equivalence: quote 1.0.0 vs 1.1.0 produce **identical comparable indexes** (zero false findings on refactors);
- the full §6 diff rulebook → canonical finding codes, including sunset boundary dates;
- consumer-impact attribution incl. L-1 internal-op exclusion and L-5 possible-usage enums;
- the gate's atomicity (injected DB failure rolls verdict + findings + audit back together) and L-2 reservation;
- notifier against a **real HTTP receiver on a live port** (payload shape, retries, failure isolation);
- the startup pipeline reproducing the entire acceptance matrix (5/6/1) and L-3 double-restart replay;
- every HTTP endpoint's success and error cases, publish/upload/recheck actions;
- **Phase 9 acceptance**: the full §7 matrix (all 12 rows, 5/6/1), consumer exposure,
  internal exclusion, live webhook receipt of every §8 alert type with payload
  shape, L-3 restart replay, and the byte-identical kit fingerprint.

Dashboard type-checks and builds via `cd client && npm run build`.

---

## Guarantees and constraints

1. **`specs/` and `consumers/` are strictly read-only.** Read via read-only handles; no code path writes them; every phase verifies the kit fingerprint is unchanged. Never modify them — evaluators test against the original kit.
2. **Atomic gate decisions.** Verdict + reason codes + findings + audit event commit in one `better-sqlite3` transaction; mid-way failures roll back completely.
3. **A blocked version never becomes baseline.** Later candidates always diff against the last *published* version.
4. **Alerts can't corrupt verdicts.** Delivery happens after commit; failures are recorded and retried, verdicts untouched.
5. **Determinism.** Same kit + same `CG_AS_OF_DATE` + same gate mode ⇒ byte-identical verdicts on every replay; the differ is a pure function of wire indexes.
6. **No hidden identity.** Versions come from `info.version`; publication order from numeric filename prefixes; consumer matching through normalized path templates + alias maps.

## Documentation map

| Document | Role |
|---|---|
| `PLAN.md` | Locked product/architecture plan: problem, features, stack, engines, acceptance matrix, API, alert design, build sequence |
| `DECISIONS.md` | Locked decision log: PO rules (x-internal, x-sunset, version policy, gate policy, spec-of-record), D-1…D-7, T-1…T-5 |
| `IMPLEMENTATION_PLAN.md` | Locked execution roadmap: L-1…L-6, canonical finding codes, phase table with definitions of done |
| `PROGRESS.md` | Current phase status with commit pointers |
| `README.md` (this file) | Full operational reference: architecture, setup, running, testing |
