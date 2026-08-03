PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clinics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  province TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  image TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  doctor_count INTEGER NOT NULL DEFAULT 0,
  last_verified_date TEXT
);

CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  specialty TEXT NOT NULL DEFAULT 'Developmental Pediatrician',
  primary_city TEXT NOT NULL,
  primary_province TEXT NOT NULL,
  contact TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  last_verified_date TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS doctor_clinics (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  submitted_at TEXT NOT NULL,
  moderated_at TEXT,
  moderator_notes TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT NOT NULL,
  moderated_at TEXT,
  moderator_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_clinics_city ON clinics(city);
CREATE INDEX IF NOT EXISTS idx_clinics_province ON clinics(province);
CREATE INDEX IF NOT EXISTS idx_clinics_status ON clinics(verified);
CREATE INDEX IF NOT EXISTS idx_doctors_city ON doctors(primary_city);
CREATE INDEX IF NOT EXISTS idx_doctors_province ON doctors(primary_province);
CREATE INDEX IF NOT EXISTS idx_doctors_status ON doctors(verified);
CREATE INDEX IF NOT EXISTS idx_doctor_clinics_doctor ON doctor_clinics(doctor_id);
CREATE INDEX IF NOT EXISTS idx_doctor_clinics_clinic ON doctor_clinics(clinic_id);
CREATE INDEX IF NOT EXISTS idx_reviews_doctor ON reviews(doctor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
CREATE INDEX IF NOT EXISTS idx_reports_doctor ON reports(doctor_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
