import type { Env } from '../types';
import { newId, sha256Hex, normalizeForMatching, similarity } from '../lib/utils';
import { bumpGeneration } from '../lib/cache';
import type { MatchDecision, RawClinicRecord, RawDoctorRecord } from './types';

/**
 * Confidence thresholds for the automatic cross-matching pipeline.
 *
 * - AUTO_MERGE_MIN: the best candidate is close enough, and clearly ahead of
 *   the runner-up, to merge into an existing record without a human.
 * - REVIEW_MIN: below AUTO_MERGE_MIN but still plausibly the same
 *   doctor/clinic — routed to the admin "Pending Review" queue instead of
 *   being discarded or silently published.
 * - Below REVIEW_MIN: treated as a genuinely new, unseen record — created
 *   directly with status='pending_review' (never 'published') so an admin
 *   still signs off before it's public.
 */
const AUTO_MERGE_MIN = 0.92;
const AUTO_MERGE_MARGIN = 0.08; // required gap over the runner-up to avoid ambiguous auto-merges
const REVIEW_MIN = 0.55;

interface Candidate {
  id: string;
  name: string;
}

async function identityHash(name: string, city: string): Promise<string> {
  return sha256Hex(`${normalizeForMatching(name)}|${normalizeForMatching(city)}`);
}

/**
 * Cross-matches one incoming doctor record against existing doctors in the
 * same city, then stages the outcome. Never publishes directly — the most
 * it does automatically is merge into an already-published record's source
 * list, or create a brand-new row that still starts as 'pending_review'.
 */
export async function matchAndStageDoctor(
  env: Env,
  record: RawDoctorRecord,
  sourceName: string,
): Promise<MatchDecision> {
  const hash = await identityHash(record.name, record.city);

  const exact = await env.DB.prepare(
    "SELECT id FROM doctors WHERE identity_hash = ? AND status != 'archived'",
  )
    .bind(hash)
    .first<{ id: string }>();

  const { results: pool } = await env.DB.prepare(
    "SELECT id, name FROM doctors WHERE primary_city = ? AND status != 'archived' LIMIT 500",
  )
    .bind(record.city)
    .all<Candidate>();

  const scored = (pool ?? [])
    .map((row) => ({ row, score: similarity(row.name, record.name) }))
    .sort((a, b) => b.score - a.score);

  const best = exact ? { row: { id: exact.id, name: record.name }, score: 1 } : scored[0];
  const runnerUp = scored.find((s) => s.row.id !== best?.row.id);

  const candidateId = newId('imp');
  const rawPayload = JSON.stringify(record);
  const normalizedName = normalizeForMatching(record.name);
  const normalizedCity = normalizeForMatching(record.city);

  if (best && (exact || (best.score >= AUTO_MERGE_MIN && best.score - (runnerUp?.score ?? 0) >= AUTO_MERGE_MARGIN))) {
    // Confident, unambiguous match -> merge sources into the existing record.
    const existing = await env.DB.prepare('SELECT sources, status FROM doctors WHERE id = ?')
      .bind(best.row.id)
      .first<{ sources: string; status: string }>();
    const sources: string[] = JSON.parse(existing?.sources ?? '[]');
    if (!sources.includes(sourceName)) sources.push(sourceName);

    await env.DB.prepare(
      "UPDATE doctors SET sources = ?, identity_hash = COALESCE(identity_hash, ?), last_verified_date = date('now'), updated_at = datetime('now') WHERE id = ?",
    )
      .bind(JSON.stringify(sources), hash, best.row.id)
      .run();

    await insertCandidateRow(env, candidateId, 'doctor', best.row.id, rawPayload, normalizedName, normalizedCity, sourceName, record.sourceUrl, best.score, 'matched');
    await logVerification(env, 'doctor', best.row.id, 'matched', sourceName, record.sourceUrl, best.score);
    await bumpGeneration(env, 'doctors');

    return { outcome: 'auto_merged', confidence: best.score, matchedEntityId: best.row.id, candidateId };
  }

  if (best && best.score >= REVIEW_MIN) {
    // Plausible but ambiguous/conflicting — needs a human. Do NOT create or touch a doctors row yet.
    await insertCandidateRow(env, candidateId, 'doctor', null, rawPayload, normalizedName, normalizedCity, sourceName, record.sourceUrl, best.score, 'conflicting');
    await logVerification(env, 'doctor', best.row.id, 'conflict_detected', sourceName, record.sourceUrl, best.score);

    return { outcome: 'flagged_conflicting', confidence: best.score, matchedEntityId: best.row.id, candidateId };
  }

  // No plausible existing match — create as a brand-new record, but never published automatically.
  const newDoctorId = newId('doc');
  await env.DB.prepare(
    `INSERT INTO doctors (id, name, specialty, primary_city, primary_province, contact_phone, contact_email, license_number, status, verified, sources, identity_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 0, ?, ?)`,
  )
    .bind(
      newDoctorId,
      record.name,
      record.specialty ?? 'Developmental Pediatrician',
      record.city,
      record.province,
      record.phone ?? null,
      record.email ?? null,
      record.licenseNumber ?? null,
      JSON.stringify([sourceName]),
      hash,
    )
    .run();

  await insertCandidateRow(env, candidateId, 'doctor', newDoctorId, rawPayload, normalizedName, normalizedCity, sourceName, record.sourceUrl, best?.score ?? 0, 'merged');
  await logVerification(env, 'doctor', newDoctorId, 'imported', sourceName, record.sourceUrl, best?.score ?? 0);
  await bumpGeneration(env, 'doctors');

  return { outcome: 'created_pending', confidence: best?.score ?? 0, matchedEntityId: newDoctorId, candidateId };
}

/** Same logic as matchAndStageDoctor, applied to clinics (matched by name + city). */
export async function matchAndStageClinic(
  env: Env,
  record: RawClinicRecord,
  sourceName: string,
): Promise<MatchDecision> {
  const hash = await identityHash(record.name, record.city);

  const exact = await env.DB.prepare(
    "SELECT id FROM clinics WHERE identity_hash = ? AND status != 'archived'",
  )
    .bind(hash)
    .first<{ id: string }>();

  const { results: pool } = await env.DB.prepare(
    "SELECT id, name FROM clinics WHERE city = ? AND status != 'archived' LIMIT 500",
  )
    .bind(record.city)
    .all<Candidate>();

  const scored = (pool ?? [])
    .map((row) => ({ row, score: similarity(row.name, record.name) }))
    .sort((a, b) => b.score - a.score);

  const best = exact ? { row: { id: exact.id, name: record.name }, score: 1 } : scored[0];
  const runnerUp = scored.find((s) => s.row.id !== best?.row.id);

  const candidateId = newId('imp');
  const rawPayload = JSON.stringify(record);
  const normalizedName = normalizeForMatching(record.name);
  const normalizedCity = normalizeForMatching(record.city);

  if (best && (exact || (best.score >= AUTO_MERGE_MIN && best.score - (runnerUp?.score ?? 0) >= AUTO_MERGE_MARGIN))) {
    await env.DB.prepare(
      "UPDATE clinics SET identity_hash = COALESCE(identity_hash, ?), last_verified_date = date('now'), updated_at = datetime('now') WHERE id = ?",
    )
      .bind(hash, best.row.id)
      .run();

    await insertCandidateRow(env, candidateId, 'clinic', best.row.id, rawPayload, normalizedName, normalizedCity, sourceName, record.sourceUrl, best.score, 'matched');
    await logVerification(env, 'clinic', best.row.id, 'matched', sourceName, record.sourceUrl, best.score);
    await bumpGeneration(env, 'clinics');

    return { outcome: 'auto_merged', confidence: best.score, matchedEntityId: best.row.id, candidateId };
  }

  if (best && best.score >= REVIEW_MIN) {
    await insertCandidateRow(env, candidateId, 'clinic', null, rawPayload, normalizedName, normalizedCity, sourceName, record.sourceUrl, best.score, 'conflicting');
    await logVerification(env, 'clinic', best.row.id, 'conflict_detected', sourceName, record.sourceUrl, best.score);

    return { outcome: 'flagged_conflicting', confidence: best.score, matchedEntityId: best.row.id, candidateId };
  }

  const newClinicId = newId('clinic');
  await env.DB.prepare(
    `INSERT INTO clinics (id, name, city, province, address, phone, lat, lng, status, verified, identity_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 0, ?)`,
  )
    .bind(newClinicId, record.name, record.city, record.province, record.address, record.phone ?? null, record.lat ?? null, record.lng ?? null, hash)
    .run();

  await insertCandidateRow(env, candidateId, 'clinic', newClinicId, rawPayload, normalizedName, normalizedCity, sourceName, record.sourceUrl, best?.score ?? 0, 'merged');
  await logVerification(env, 'clinic', newClinicId, 'imported', sourceName, record.sourceUrl, best?.score ?? 0);
  await bumpGeneration(env, 'clinics');

  return { outcome: 'created_pending', confidence: best?.score ?? 0, matchedEntityId: newClinicId, candidateId };
}

async function insertCandidateRow(
  env: Env,
  id: string,
  entityType: 'doctor' | 'clinic',
  matchedEntityId: string | null,
  rawPayload: string,
  normalizedName: string,
  normalizedCity: string,
  sourceName: string,
  sourceUrl: string | undefined,
  confidence: number,
  matchStatus: 'matched' | 'conflicting' | 'merged' | 'unmatched' | 'discarded',
) {
  await env.DB.prepare(
    `INSERT INTO import_candidates
      (id, entity_type, matched_entity_id, raw_payload, normalized_name, normalized_city, source_name, source_url, confidence_score, match_status, reviewed_at, reviewed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      entityType,
      matchedEntityId,
      rawPayload,
      normalizedName,
      normalizedCity,
      sourceName,
      sourceUrl ?? null,
      confidence,
      matchStatus,
      matchStatus === 'conflicting' ? null : new Date().toISOString(),
      matchStatus === 'conflicting' ? null : 'pipeline',
    )
    .run();
}

async function logVerification(
  env: Env,
  entityType: 'doctor' | 'clinic',
  entityId: string,
  action: string,
  sourceName: string,
  sourceUrl: string | undefined,
  confidence: number,
) {
  await env.DB.prepare(
    `INSERT INTO verification_logs (id, entity_type, entity_id, action, source_name, source_url, confidence_score, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('vlog'), entityType, entityId, action, sourceName, sourceUrl ?? null, confidence, JSON.stringify({ actor: 'import-pipeline' }))
    .run();
}
