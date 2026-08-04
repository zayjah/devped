import type { Env } from './index.js';

// ============================================================================
// Types
// ============================================================================

export interface RawClinicRecord {
  name: string;
  city: string;
  province: string;
  address: string;
  phone: string;
  lat: number;
  lng: number;
  image: string | null;
  source: string;
}

export interface SourceAdapter {
  name: string;
  fetchClinics(env: Env): Promise<RawClinicRecord[]>;
  // Doctor-level data (specialty, schedule) has no wired source yet — see
  // README note. Adapters that can't supply doctors should just return [].
  fetchDoctors(env: Env): Promise<never[]>;
}

interface ClinicRow {
  id: string;
  name: string;
  city: string;
  province: string;
  address: string;
  phone: string;
  lat: number;
  lng: number;
  image: string | null;
  verified: number;
  doctor_count: number;
  last_verified_date: string | null;
  status: string;
}

interface AdapterSummary {
  adapter: string;
  status: 'completed' | 'partial' | 'failed';
  fetchedClinics: number;
  autoMerged: number;
  pending: number;
  conflicting: number;
  errors: string[];
}

// ============================================================================
// Matching utilities
// ============================================================================

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

// Dice's coefficient over character bigrams — cheap, dependency-free, and
// tolerant of minor spelling/formatting differences between sources (e.g.
// "St. Luke's Medical Center" vs "St Lukes Medical Center - BGC").
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 || bb.size === 0) return na === nb ? 1 : 0;
  let overlap = 0;
  for (const g of ba) if (bb.has(g)) overlap++;
  return (2 * overlap) / (ba.size + bb.size);
}

function identityHash(name: string, city: string): string {
  return `${normalize(name)}|${normalize(city)}`;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function logVerification(
  db: D1Database,
  entityType: string,
  entityId: string | null,
  action: string,
  detail: string
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO verification_logs (id, entity_type, entity_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(newId('vlog'), entityType, entityId, action, detail, new Date().toISOString()).run();
  } catch (err) {
    // Logging is best-effort — never let a logging failure break an import.
    console.error('verification_logs write failed', err);
  }
}

// ============================================================================
// Cross-matching + staging for a single incoming clinic record
// ============================================================================

const AUTO_MERGE_THRESHOLD = 0.92;
const AUTO_MERGE_MARGIN = 0.05;
const CONFLICT_LOWER_BOUND = 0.55;

export async function matchAndStageClinic(
  db: D1Database,
  raw: RawClinicRecord
): Promise<'auto_merged' | 'staged_conflict' | 'inserted_pending'> {
  const hash = identityHash(raw.name, raw.city);

  const candidates = await db.prepare(
    `SELECT * FROM clinics WHERE city = ?`
  ).bind(raw.city).all<ClinicRow>();
  const rows = candidates.results || [];

  // Exact identity-hash match short-circuits straight to auto-merge.
  const exact = rows.find((r) => identityHash(r.name, r.city) === hash);

  let best: { row: ClinicRow; score: number } | null = null;
  let runnerUp: { row: ClinicRow; score: number } | null = null;

  if (!exact) {
    for (const row of rows) {
      const score = similarity(raw.name, row.name);
      if (!best || score > best.score) {
        runnerUp = best;
        best = { row, score };
      } else if (!runnerUp || score > runnerUp.score) {
        runnerUp = { row, score };
      }
    }
  }

  const target = exact ? { row: exact, score: 1 } : best;
  const margin = target && runnerUp ? target.score - runnerUp.score : 1;

  if (target && (exact || (target.score >= AUTO_MERGE_THRESHOLD && margin >= AUTO_MERGE_MARGIN))) {
    // Auto-merge: append this source, bump last_verified_date. Status is
    // left untouched — a pending_review clinic merged this way stays
    // pending_review until an admin actually reviews it.
    await db.prepare(
      `UPDATE clinics SET phone = COALESCE(NULLIF(phone, ''), ?), last_verified_date = ? WHERE id = ?`
    ).bind(raw.phone, new Date().toISOString().slice(0, 10), target.row.id).run();
    await logVerification(db, 'clinic', target.row.id, 'import_auto_merge', `source=${raw.source} score=${target.score.toFixed(3)}`);
    return 'auto_merged';
  }

  if (target && target.score >= CONFLICT_LOWER_BOUND) {
    // Ambiguous — stage for a human to resolve rather than guessing.
    await db.prepare(
      `INSERT INTO import_candidates (id, kind, source, raw_json, match_status, best_match_id, best_match_score, created_at)
       VALUES (?, 'clinic', ?, ?, 'conflicting', ?, ?, ?)`
    ).bind(newId('cand'), raw.source, JSON.stringify(raw), target.row.id, target.score, new Date().toISOString()).run();
    await logVerification(db, 'clinic', target.row.id, 'import_staged_conflict', `source=${raw.source} score=${target.score.toFixed(3)}`);
    return 'staged_conflict';
  }

  // No plausible match — insert as a brand-new row, never published directly.
  const id = newId('clinic');
  await db.prepare(`
    INSERT INTO clinics (id, name, city, province, address, phone, lat, lng, image, verified, doctor_count, last_verified_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'pending_review')
  `).bind(id, raw.name, raw.city, raw.province, raw.address, raw.phone, raw.lat, raw.lng, raw.image, new Date().toISOString().slice(0, 10)).run();
  await logVerification(db, 'clinic', id, 'import_new_pending', `source=${raw.source}`);
  return 'inserted_pending';
}

// ============================================================================
// Google Places adapter
// ============================================================================

// Starting coverage — add more as you verify results. Each city runs one
// Text Search call plus one Place Details call per result (for phone), so
// keep this list deliberately short until you've checked API costs.
const TARGET_CITIES: Array<{ city: string; province: string }> = [
  { city: 'Cebu City', province: 'Cebu' },
  { city: 'Taguig', province: 'Metro Manila' },
  { city: 'Davao City', province: 'Davao del Sur' },
  { city: 'Quezon City', province: 'Metro Manila' },
  { city: 'Iloilo City', province: 'Iloilo' },
];

interface PlacesTextSearchResult {
  place_id: string;
  name: string;
  formatted_address?: string;
  geometry?: { location?: { lat: number; lng: number } };
  photos?: Array<{ photo_reference: string }>;
}

async function fetchPlaceDetails(placeId: string, apiKey: string): Promise<{ phone: string } | null> {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=formatted_phone_number&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json<{ result?: { formatted_phone_number?: string } }>();
  return { phone: data.result?.formatted_phone_number || '' };
}

export const googlePlacesAdapter: SourceAdapter = {
  name: 'google-places',

  async fetchClinics(env: Env): Promise<RawClinicRecord[]> {
    const apiKey = (env as Env & { GOOGLE_PLACES_API_KEY?: string }).GOOGLE_PLACES_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set (wrangler secret put GOOGLE_PLACES_API_KEY)');

    const out: RawClinicRecord[] = [];

    for (const target of TARGET_CITIES) {
      const query = `developmental pediatric clinic OR children's hospital in ${target.city}, Philippines`;
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`Places text search failed for ${target.city}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json<{ results?: PlacesTextSearchResult[]; status: string }>();
      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        console.error(`Places text search error for ${target.city}: ${data.status}`);
        continue;
      }

      for (const place of data.results || []) {
        const details = await fetchPlaceDetails(place.place_id, apiKey).catch(() => null);
        out.push({
          name: place.name,
          city: target.city,
          province: target.province,
          address: place.formatted_address || '',
          phone: details?.phone || '',
          lat: place.geometry?.location?.lat ?? 0,
          lng: place.geometry?.location?.lng ?? 0,
          image: place.photos?.[0]
            ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${place.photos[0].photo_reference}&key=${apiKey}`
            : null,
          source: 'Google Places',
        });
      }
    }

    return out;
  },

  // Places doesn't expose individual doctors — this adapter only supplies
  // clinics. Add a second adapter (e.g. a PSDBP directory scrape or a synced
  // spreadsheet) to `registry` below once you've picked a doctor-level source.
  async fetchDoctors(): Promise<never[]> {
    return [];
  },
};

export const registry: SourceAdapter[] = [googlePlacesAdapter];

// ============================================================================
// Running the pipeline + logging each run
// ============================================================================

export async function runImport(db: D1Database, env: Env): Promise<AdapterSummary[]> {
  const summaries: AdapterSummary[] = [];

  for (const adapter of registry) {
    const logId = newId('ilog');
    const startedAt = new Date().toISOString();
    await db.prepare(
      `INSERT INTO import_logs (id, adapter, status, fetched_clinics, auto_merged, pending, conflicting, errors_json, started_at)
       VALUES (?, ?, 'partial', 0, 0, 0, 0, '[]', ?)`
    ).bind(logId, adapter.name, startedAt).run().catch((err) => console.error('import_logs insert failed', err));

    const errors: string[] = [];
    let autoMerged = 0, pending = 0, conflicting = 0, fetchedClinics = 0;

    try {
      const clinics = await adapter.fetchClinics(env);
      fetchedClinics = clinics.length;
      for (const raw of clinics) {
        try {
          const result = await matchAndStageClinic(db, raw);
          if (result === 'auto_merged') autoMerged++;
          else if (result === 'staged_conflict') conflicting++;
          else pending++;
        } catch (err) {
          errors.push(`clinic "${raw.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`fetchClinics: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Doctors: independent try/catch so a doctor-fetch failure never blocks
    // the clinic results already gathered above, and vice versa.
    try {
      await adapter.fetchDoctors(env);
    } catch (err) {
      errors.push(`fetchDoctors: ${err instanceof Error ? err.message : String(err)}`);
    }

    const status: AdapterSummary['status'] = errors.length === 0 ? 'completed' : (fetchedClinics > 0 ? 'partial' : 'failed');

    await db.prepare(
      `UPDATE import_logs SET status=?, fetched_clinics=?, auto_merged=?, pending=?, conflicting=?, errors_json=?, finished_at=? WHERE id=?`
    ).bind(status, fetchedClinics, autoMerged, pending, conflicting, JSON.stringify(errors), new Date().toISOString(), logId)
      .run().catch((err) => console.error('import_logs update failed', err));

    summaries.push({ adapter: adapter.name, status, fetchedClinics, autoMerged, pending, conflicting, errors });
  }

  return summaries;
}
