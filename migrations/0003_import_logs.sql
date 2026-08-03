-- DevPed PH — import run logging
-- Cloudflare D1 (SQLite dialect)
--
-- NOTE: verification_logs already exists (see migrations/0001_init.sql).
-- This migration only adds import_logs.
--
-- import_logs records one row per runImport() execution (src/importer/run.ts),
-- summarizing what each source adapter did. This is separate from
-- import_candidates, which stores the individual staged records themselves.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS import_logs (
  id                            TEXT PRIMARY KEY,
  source_name                   TEXT NOT NULL,                 -- e.g. "PSDBP Listing", matches adapter.name

  doctors_fetched               INTEGER NOT NULL DEFAULT 0,
  doctors_auto_merged           INTEGER NOT NULL DEFAULT 0,
  doctors_created_pending       INTEGER NOT NULL DEFAULT 0,
  doctors_flagged_conflicting   INTEGER NOT NULL DEFAULT 0,

  clinics_fetched               INTEGER NOT NULL DEFAULT 0,
  clinics_auto_merged           INTEGER NOT NULL DEFAULT 0,
  clinics_created_pending       INTEGER NOT NULL DEFAULT 0,
  clinics_flagged_conflicting   INTEGER NOT NULL DEFAULT 0,

  errors                        TEXT NOT NULL DEFAULT '[]',    -- JSON array of error strings from the run
  status                        TEXT NOT NULL DEFAULT 'completed'
                                  CHECK (status IN ('completed', 'failed', 'partial')),

  started_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at                   TEXT,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_import_logs_source ON import_logs(source_name);
CREATE INDEX IF NOT EXISTS idx_import_logs_status ON import_logs(status);
CREATE INDEX IF NOT EXISTS idx_import_logs_started ON import_logs(started_at);
