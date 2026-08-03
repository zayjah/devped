-- DevPed PH — initial schema
-- Cloudflare D1 (SQLite dialect)

PRAGMA foreign_keys = ON;

-- ============================================================
-- doctors
-- ============================================================
CREATE TABLE IF NOT EXISTS doctors (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  specialty           TEXT NOT NULL DEFAULT 'Developmental Pediatrician',
  photo_url           TEXT,
  primary_city        TEXT NOT NULL,
  primary_province    TEXT NOT NULL,
  contact_phone       TEXT,
  contact_email       TEXT,
  license_number      TEXT,
  rating              REAL NOT NULL DEFAULT 0,
  review_count        INTEGER NOT NULL DEFAULT 0,
  verified            INTEGER NOT NULL DEFAULT 0,             -- 0/1
  -- published: visible via public API
  -- pending_review: newly imported / conflicting, hidden from public API
  -- rejected: dismissed by an admin, hidden from public API
  -- archived: soft-deleted
  status              TEXT NOT NULL DEFAULT 'pending_review'
                        CHECK (status IN ('published','pending_review','rejected','archived')),
  sources             TEXT NOT NULL DEFAULT '[]',             -- JSON array of source names, e.g. ["PSDBP Listing","Google Maps"]
  last_verified_date  TEXT,
  identity_hash       TEXT,                                   -- hash of normalized name+city, used for import matching
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_doctors_status    ON doctors(status);
CREATE INDEX IF NOT EXISTS idx_doctors_city      ON doctors(primary_city);
CREATE INDEX IF NOT EXISTS idx_doctors_province  ON doctors(primary_province);
CREATE INDEX IF NOT EXISTS idx_doctors_identity  ON doctors(identity_hash);

-- Full text search over doctors (name / city / province)
CREATE VIRTUAL TABLE IF NOT EXISTS doctors_fts USING fts5(
  id UNINDEXED,
  name,
  primary_city,
  primary_province,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS doctors_fts_ai AFTER INSERT ON doctors BEGIN
  INSERT INTO doctors_fts(id, name, primary_city, primary_province)
  VALUES (new.id, new.name, new.primary_city, new.primary_province);
END;

CREATE TRIGGER IF NOT EXISTS doctors_fts_ad AFTER DELETE ON doctors BEGIN
  DELETE FROM doctors_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS doctors_fts_au AFTER UPDATE ON doctors BEGIN
  DELETE FROM doctors_fts WHERE id = old.id;
  INSERT INTO doctors_fts(id, name, primary_city, primary_province)
  VALUES (new.id, new.name, new.primary_city, new.primary_province);
END;

-- ============================================================
-- clinics
-- ============================================================
CREATE TABLE IF NOT EXISTS clinics (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  city                TEXT NOT NULL,
  province            TEXT NOT NULL,
  address             TEXT NOT NULL,
  phone               TEXT,
  lat                 REAL,
  lng                 REAL,
  image               TEXT,
  verified            INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending_review'
                        CHECK (status IN ('published','pending_review','rejected','archived')),
  last_verified_date  TEXT,
  identity_hash       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clinics_city      ON clinics(city);
CREATE INDEX IF NOT EXISTS idx_clinics_province  ON clinics(province);
CREATE INDEX IF NOT EXISTS idx_clinics_status    ON clinics(status);
CREATE INDEX IF NOT EXISTS idx_clinics_identity  ON clinics(identity_hash);

-- ============================================================
-- doctor_clinics (many-to-many: a doctor can practice at several clinics)
-- ============================================================
CREATE TABLE IF NOT EXISTS doctor_clinics (
  id          TEXT PRIMARY KEY,
  doctor_id   TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id   TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  schedule    TEXT,                                   -- free text, e.g. "Mon, Wed, Fri · 1:00–4:00 PM"
  is_primary  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doctor_id, clinic_id)
);

CREATE INDEX IF NOT EXISTS idx_doctor_clinics_doctor ON doctor_clinics(doctor_id);
CREATE INDEX IF NOT EXISTS idx_doctor_clinics_clinic ON doctor_clinics(clinic_id);

-- ============================================================
-- reviews (parent reviews of a doctor — always start as "pending")
-- ============================================================
CREATE TABLE IF NOT EXISTS reviews (
  id             TEXT PRIMARY KEY,
  doctor_id      TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  author_name    TEXT NOT NULL DEFAULT 'Anonymous',
  rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  ip_hash        TEXT,                                 -- salted hash, never raw IP
  submitted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  moderated_at   TEXT,
  moderated_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_doctor ON reviews(doctor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

-- ============================================================
-- reports ("report incorrect information" on a doctor/clinic)
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
  id             TEXT PRIMARY KEY,
  doctor_id      TEXT REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id      TEXT REFERENCES clinics(id) ON DELETE CASCADE,
  reason         TEXT NOT NULL,                         -- wrongAddress | wrongPhone | doctorNotThere | closedPermanently | other
  details        TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','resolved','dismissed')),
  ip_hash        TEXT,
  submitted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_doctor ON reports(doctor_id);
CREATE INDEX IF NOT EXISTS idx_reports_clinic ON reports(clinic_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- ============================================================
-- verification_logs (audit trail for every automated/manual verification action)
-- ============================================================
CREATE TABLE IF NOT EXISTS verification_logs (
  id                TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL CHECK (entity_type IN ('doctor','clinic')),
  entity_id         TEXT NOT NULL,
  action            TEXT NOT NULL,                       -- imported | matched | conflict_detected | auto_verified | manually_verified | rejected | merged
  source_name       TEXT,
  source_url        TEXT,
  confidence_score  REAL,
  details            TEXT,                                -- JSON blob with free-form context
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_verification_logs_entity ON verification_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_verification_logs_action ON verification_logs(action);

-- ============================================================
-- import_candidates (staging area for the automatic import / cross-matching
-- pipeline — see src/importer/. Nothing here is public until it is matched
-- or promoted into doctors/clinics with status='published'.)
-- ============================================================
CREATE TABLE IF NOT EXISTS import_candidates (
  id                  TEXT PRIMARY KEY,
  entity_type         TEXT NOT NULL CHECK (entity_type IN ('doctor','clinic')),
  matched_entity_id   TEXT,                               -- set once cross-matched to an existing row
  raw_payload         TEXT NOT NULL,                       -- JSON of the fetched/scraped record, as-is
  normalized_name     TEXT,
  normalized_city     TEXT,
  source_name         TEXT NOT NULL,                       -- e.g. "PSDBP Listing", "Hospital Directory"
  source_url          TEXT,
  confidence_score    REAL,                                 -- 0..1 match confidence against existing records
  -- unmatched: brand-new candidate, no similar existing record
  -- matched: confidently matches one existing record (auto-mergeable)
  -- conflicting: matches multiple records, or fields disagree beyond tolerance -> needs a human
  -- merged: an admin/pipeline merged it into doctors/clinics
  -- discarded: rejected as noise/duplicate/irrelevant
  match_status        TEXT NOT NULL DEFAULT 'unmatched'
                        CHECK (match_status IN ('unmatched','matched','conflicting','merged','discarded')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at         TEXT,
  reviewed_by         TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_candidates_status ON import_candidates(match_status);
CREATE INDEX IF NOT EXISTS idx_import_candidates_entity ON import_candidates(entity_type);
