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
  // cityFilter limits a run to a single target city so the total subrequest
  // count (1 search + 1 details call per result) stays under the Workers
  // per-invocation limit. Omit to run every configured city — only safe if
  // your account's subrequest limit is high enough (paid plans).
  fetchClinics(env: Env, cityFilter?: string): Promise<RawClinicRecord[]>;
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

// The production import_candidates table turned out to predate this
// codebase's schema by more than one column — first `entity_type`, now
// `raw_payload`, both NOT NULL with no default and both absent from this
// file's own schema. Rather than keep adding one more hardcoded
// column-name guess every time a new one surfaces, this builds the INSERT
// dynamically: it only writes columns that actually exist on the table,
// and for any *other* NOT NULL column with no default (i.e. any further
// unknown legacy leftover), it fills in the closest semantic match by
// column name so the insert doesn't fail on a constraint the code can't
// see by name alone.
async function insertImportCandidate(
  db: D1Database,
  values: {
    id: string;
    kind: string;
    source: string;
    rawJson: string;
    matchStatus: string;
    bestMatchId: string | null;
    bestMatchScore: number | null;
    createdAt: string;
  }
): Promise<void> {
  const info = await db
    .prepare(`PRAGMA table_info(import_candidates)`)
    .all<{ name: string; notnull: number; dflt_value: string | null }>();
  const columns = info.results || [];
  const existing = new Set(columns.map((c) => c.name));

  const insertCols: string[] = [];
  const insertVals: unknown[] = [];
  const addCol = (name: string, value: unknown) => {
    insertCols.push(name);
    insertVals.push(value);
  };

  const knownColumns: Record<string, unknown> = {
    id: values.id,
    kind: values.kind,
    source: values.source,
    raw_json: values.rawJson,
    match_status: values.matchStatus,
    best_match_id: values.bestMatchId,
    best_match_score: values.bestMatchScore,
    created_at: values.createdAt,
  };
  for (const [name, value] of Object.entries(knownColumns)) {
    if (existing.has(name)) addCol(name, value);
  }

  for (const col of columns) {
    if (col.name in knownColumns) continue;
    if (col.notnull && col.dflt_value === null) {
      const lower = col.name.toLowerCase();
      let guess: unknown = values.kind;
      if (lower.includes('json') || lower.includes('payload') || lower.includes('data') || lower.includes('raw')) {
        guess = values.rawJson;
      } else if (lower.includes('status')) {
        guess = values.matchStatus;
      } else if (lower.includes('source')) {
        guess = values.source;
      } else if (lower.includes('score')) {
        guess = values.bestMatchScore ?? 0;
      } else if (lower.includes('id')) {
        guess = values.bestMatchId ?? values.id;
      } else if (lower.includes('at') || lower.includes('date') || lower.includes('time')) {
        guess = values.createdAt;
      }
      addCol(col.name, guess);
    }
  }

  const placeholders = insertCols.map(() => '?').join(', ');
  await db
    .prepare(`INSERT INTO import_candidates (${insertCols.join(', ')}) VALUES (${placeholders})`)
    .bind(...insertVals)
    .run();
}

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
    await insertImportCandidate(db, {
      id: newId('cand'),
      kind: 'clinic',
      source: raw.source,
      rawJson: JSON.stringify(raw),
      matchStatus: 'conflicting',
      bestMatchId: target.row.id,
      bestMatchScore: target.score,
      createdAt: new Date().toISOString(),
    });
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
export const TARGET_CITIES: Array<{ city: string; province: string }> = [
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

// Caps subrequests per city (1 search + up to this many details calls) so
// that even a full multi-city run stays well under the Workers free-plan
// limit of 50 subrequests per invocation.
const MAX_RESULTS_PER_CITY = 8;

export const googlePlacesAdapter: SourceAdapter = {
  name: 'google-places',

  async fetchClinics(env: Env, cityFilter?: string): Promise<RawClinicRecord[]> {
    const apiKey = (env as Env & { GOOGLE_PLACES_API_KEY?: string }).GOOGLE_PLACES_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set (wrangler secret put GOOGLE_PLACES_API_KEY)');

    const out: RawClinicRecord[] = [];
    const issues: string[] = [];
    const cities = cityFilter
      ? TARGET_CITIES.filter((t) => t.city.toLowerCase() === cityFilter.toLowerCase())
      : TARGET_CITIES;
    if (cityFilter && cities.length === 0) {
      throw new Error(`Unknown city "${cityFilter}". Valid options: ${TARGET_CITIES.map((t) => t.city).join(', ')}`);
    }

    for (const target of cities) {
      const query = `developmental pediatric clinic OR children's hospital in ${target.city}, Philippines`;
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        issues.push(`${target.city}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json<{ results?: PlacesTextSearchResult[]; status: string; error_message?: string }>();
      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        issues.push(`${target.city}: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
        continue;
      }

      for (const place of (data.results || []).slice(0, MAX_RESULTS_PER_CITY)) {
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

    // Every city failed and nothing was fetched — surface the real reason
    // (bad key, billing not enabled, API not enabled, etc.) instead of
    // returning silently with an empty array, which looked like success.
    if (out.length === 0 && issues.length > 0) {
      throw new Error(issues.join(' | '));
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

export async function runImport(db: D1Database, env: Env, cityFilter?: string): Promise<AdapterSummary[]> {
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
      const clinics = await adapter.fetchClinics(env, cityFilter);
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
