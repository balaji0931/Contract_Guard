# Contract Guard — Progress

Last updated: 2026-11-18. Phases follow `IMPLEMENTATION_PLAN.md` exactly; a phase
starts only after the previous one is committed and the user instructs it.

| Phase | Deliverable | Status | Commit |
|---|---|---|---|
| 0 — Foundations | Config, logger, SQLite + migrations, health endpoint | ✅ done | `c73784e` |
| 1 — Intake | Spec/consumer discovery, read-only loading, validation, idempotent intake | ✅ done | `1e49f8b` |
| 2 — Wire index | Schema walker, operation index, alias map, consumer index, wire store | ✅ done | `4110468` |
| 3 — Diff engine | Wire diff rulebook → finding codes, baseline selection, sunset domain | ✅ done | `e9e435b` |
| 4 — Consumer impact | Attribute findings to manifest consumers (L-1 exclusion, L-5 enums, D-3 aliases) | ✅ done | `60c3841` |
| 5 — Publication gate | L-1 verdict + L-2 reservation + baseline + audit, one transaction | ✅ done | `cdcfc83` |
| 6 — Notifier | §8 webhook alerts, retries/backoff, `alerts` persistence | ✅ done | `c852369` |
| 7 — Startup + sunsets | Auto-scan, publish in file order, sunset engine, L-3 replay | ✅ done | `becd329` |
| 8 — API + dashboard | Registry/findings/consumers/alerts/recheck/publish endpoints + dashboard | ✅ done (server-rendered v1) | `4076dc3` |
| 8b — Dashboard upgrade | React + Vite + Tailwind CSS SPA (`contract-guard/client/`, lucide-react) replacing the HTML template, per PO instruction 2026-11-18 | ✅ done | — (uncommitted) |
| 9 — Acceptance + docs | Full end-to-end acceptance run + demo instructions | ✅ done (uncommitted — awaiting review) | — |

## Evidence so far

- Tests: **186 passing (15 files, one suite per phase)** — including the Phase 9
  acceptance suite: all 12 §7 matrix rows + 5/6/1 totals asserted against the
  persisted registry, consumer exposure (mobile-app `amount`/`amountApproved`,
  payments-svc `legacyCode`, partner-portal `requestedBy`/`type`,
  notifications-svc clean), internal-op exclusion, 16 §8 alerts received by a
  live receiver with §8 payload shape, L-3 double-replay (events/alerts
  double, verdicts identical), and a byte-identical kit fingerprint after
  every code path (pipeline, publish, upload, recheck) · backend `tsc --noEmit`
  clean · backend build green · client `tsc --noEmit && vite build` green
  (246 kB JS / 76 kB gzip, 22 kB CSS) · live smoke: `GET /` serves the React
  shell + hashed assets, `/api/*` answers, pipeline replays at startup.
- Kit fingerprint unchanged every phase (`specs/` + `consumers/`, 16 files).
- Acceptance matrix already decided end-to-end at pipeline level: **5 published /
  6 blocked / 1 rejected**, exposed: mobile-app (2), payments-svc (1),
  partner-portal (1), notifications-svc clean; internal pricing-cache excluded.

## Decisions in force

L-1…L-6 (locked PO rules), D-1…D-7, T-1…T-5 in `DECISIONS.md`.
**2026-11-18 PO instruction:** dashboard stack becomes React + Vite + Tailwind
(supersedes T-5's plain-HTML note); `PLAN.md` §5/§9 and
`IMPLEMENTATION_PLAN.md` Phase 8 updated accordingly.
