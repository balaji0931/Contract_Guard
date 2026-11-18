/**
 * Database migrations. Ordered, forward-only, each applied inside its own
 * transaction and recorded in `schema_migrations`, so re-running is a no-op.
 *
 * Phase 0 installs the baseline registry schema described in PLAN.md §5.
 * Later phases may add migrations by appending to MIGRATIONS — never by
 * editing an entry that has already shipped.
 */

export interface Migration {
  /** Zero-padded, lexically ordered identifier. */
  id: string;
  description: string;
  sql: string;
}

const BASELINE = `
CREATE TABLE services (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  title       TEXT,
  owner       TEXT,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE spec_versions (
  id           INTEGER PRIMARY KEY,
  service_id   INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  -- A reserved version is occupied whether or not it was ever published
  -- (locked decision L-2): published, blocked and invalid intake all reserve.
  status       TEXT NOT NULL CHECK (status IN ('staged', 'published', 'blocked', 'rejected', 'invalid')),
  outcome_reason_code TEXT,
  source_file  TEXT,
  content_hash TEXT,
  title        TEXT,
  description  TEXT,
  owner        TEXT,
  info_version TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- One row per intake attempt. Version reservation (L-2) is enforced by the
  -- gate against these rows, not by a constraint here: a rejected duplicate
  -- (for example the corrected claims-api 1.1.0 file) must still be recorded.
  UNIQUE (service_id, version, source_file)
);

CREATE TABLE operations (
  id               INTEGER PRIMARY KEY,
  spec_version_id  INTEGER NOT NULL REFERENCES spec_versions(id) ON DELETE CASCADE,
  method           TEXT NOT NULL,
  path_template    TEXT NOT NULL,
  -- Path with every {param} collapsed to {} so /quotes/{id} matches /quotes/{quoteId}.
  normalized_path  TEXT NOT NULL,
  operation_id     TEXT,
  summary          TEXT,
  is_internal      INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1)),
  UNIQUE (spec_version_id, method, path_template)
);

CREATE TABLE wire_fields (
  id             INTEGER PRIMARY KEY,
  operation_id   INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  direction      TEXT NOT NULL CHECK (direction IN ('request', 'response')),
  status_code    TEXT,
  field_path     TEXT NOT NULL,
  type           TEXT,
  format         TEXT,
  required       INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  enum_values    TEXT,
  deprecated     INTEGER NOT NULL DEFAULT 0 CHECK (deprecated IN (0, 1)),
  sunset_date    TEXT,
  UNIQUE (operation_id, direction, status_code, field_path)
);

CREATE TABLE consumers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  team       TEXT,
  source_file TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE consumer_uses (
  id              INTEGER PRIMARY KEY,
  consumer_id     INTEGER NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  method          TEXT NOT NULL,
  path_template   TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  UNIQUE (consumer_id, provider, method, path_template)
);

CREATE TABLE consumer_use_fields (
  id         INTEGER PRIMARY KEY,
  use_id     INTEGER NOT NULL REFERENCES consumer_uses(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('sends', 'reads')),
  field_path TEXT NOT NULL,
  UNIQUE (use_id, direction, field_path)
);

CREATE TABLE findings (
  id              INTEGER PRIMARY KEY,
  spec_version_id INTEGER NOT NULL REFERENCES spec_versions(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('blocking', 'warning', 'info', 'intake_reject')),
  operation_ref   TEXT,
  field_path      TEXT,
  consumer_id     INTEGER REFERENCES consumers(id) ON DELETE SET NULL,
  message         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE alerts (
  id           INTEGER PRIMARY KEY,
  webhook_path TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  http_status  INTEGER,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at      TEXT
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind        TEXT NOT NULL,
  service     TEXT,
  version     TEXT,
  outcome     TEXT,
  detail      TEXT
);

CREATE INDEX idx_spec_versions_service ON spec_versions (service_id, version);
CREATE INDEX idx_operations_lookup     ON operations (normalized_path, method);
CREATE INDEX idx_wire_fields_lookup    ON wire_fields (operation_id, direction);
CREATE INDEX idx_findings_version      ON findings (spec_version_id, code);
CREATE INDEX idx_events_kind           ON events (kind, occurred_at);
`;

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_baseline_registry_schema",
    description: "Core registry tables: services, spec versions, operations, wire fields, consumers, findings, alerts, events",
    sql: BASELINE,
  },
];
