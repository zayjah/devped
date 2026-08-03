import { Hono } from 'hono';
import type { Env } from '../types';
import { errorJson, json, newId } from '../lib/utils';
import { bumpGeneration } from '../lib/cache';
import { requireAdmin } from '../lib/adminAuth';
import { runImport } from '../importer/run';

/**
 * Everything under /api/admin/* is for the admin.js dashboard shell
 * (devped-ph-web/pages/admin.js) and requires the X-Admin-Key header.
 * Put Cloudflare Access in front of this in production — see adminAuth.ts.
 */
export const adminRoute = new Hono<{ Bindings: Env }>();
adminRoute.use('*', requireAdmin());

// ---------------------------------------------------------------- doctors --
adminRoute.get('/doctors', async (c) => {
  const status = c.req.query('status') ?? 'pending_review';
  const { results } = await c.env.DB.prepare('SELECT * FROM doctors WHERE status = ? ORDER BY created_at DESC LIMIT 200')
    .bind(status)
    .all();
  return c.json(results ?? []);
});

adminRoute.post('/doctors/:id/approve', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    "UPDATE doctors SET status = 'published', verified = 1, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
  await logVerification(c.env, 'doctor', id, 'manually_verified', 'admin');
  await bumpGeneration(c.env, 'doctors');
  return json({ id, status: 'published' });
});

adminRoute.post('/doctors/:id/reject', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare("UPDATE doctors SET status = 'rejected', updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  await logVerification(c.env, 'doctor', id, 'rejected', 'admin');
  await bumpGeneration(c.env, 'doctors');
  return json({ id, status: 'rejected' });
});

// ----------------------------------------------------------------- clinics --
adminRoute.get('/clinics', async (c) => {
  const status = c.req.query('status') ?? 'pending_review';
  const { results } = await c.env.DB.prepare('SELECT * FROM clinics WHERE status = ? ORDER BY created_at DESC LIMIT 200')
    .bind(status)
    .all();
  return c.json(results ?? []);
});

adminRoute.post('/clinics/:id/approve', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    "UPDATE clinics SET status = 'published', verified = 1, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
  await logVerification(c.env, 'clinic', id, 'manually_verified', 'admin');
  await bumpGeneration(c.env, 'clinics');
  return json({ id, status: 'published' });
});

adminRoute.post('/clinics/:id/reject', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare("UPDATE clinics SET status = 'rejected', updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  await logVerification(c.env, 'clinic', id, 'rejected', 'admin');
  await bumpGeneration(c.env, 'clinics');
  return json({ id, status: 'rejected' });
});

// ----------------------------------------------------------------- reviews --
adminRoute.get('/reviews', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, d.name AS doctor_name FROM reviews r
     JOIN doctors d ON d.id = r.doctor_id
     WHERE r.status = ? ORDER BY r.submitted_at DESC LIMIT 200`,
  )
    .bind(status)
    .all();
  return c.json(results ?? []);
});

adminRoute.post('/reviews/:id/approve', async (c) => {
  const id = c.req.param('id');
  const review = await c.env.DB.prepare('SELECT doctor_id FROM reviews WHERE id = ?').bind(id).first<{ doctor_id: string }>();
  if (!review) return errorJson('Review not found', 404);

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE reviews SET status = 'approved', moderated_at = datetime('now'), moderated_by = 'admin' WHERE id = ?").bind(id),
  ]);
  await recomputeDoctorRating(c.env, review.doctor_id);
  await bumpGeneration(c.env, 'reviews');
  await bumpGeneration(c.env, 'doctors');
  return json({ id, status: 'approved' });
});

adminRoute.post('/reviews/:id/reject', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare("UPDATE reviews SET status = 'rejected', moderated_at = datetime('now'), moderated_by = 'admin' WHERE id = ?")
    .bind(id)
    .run();
  await bumpGeneration(c.env, 'reviews');
  return json({ id, status: 'rejected' });
});

// ----------------------------------------------------------------- reports --
adminRoute.get('/reports', async (c) => {
  const status = c.req.query('status') ?? 'open';
  const { results } = await c.env.DB.prepare('SELECT * FROM reports WHERE status = ? ORDER BY submitted_at DESC LIMIT 200')
    .bind(status)
    .all();
  return c.json(results ?? []);
});

adminRoute.post('/reports/:id/resolve', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare("UPDATE reports SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return json({ id, status: 'resolved' });
});

// --------------------------------------------------------- import review queue --
adminRoute.get('/import-candidates', async (c) => {
  const status = c.req.query('status') ?? 'conflicting';
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM import_candidates WHERE match_status = ? ORDER BY created_at DESC LIMIT 200',
  )
    .bind(status)
    .all();
  return c.json(results ?? []);
});

adminRoute.post('/import-candidates/:id/discard', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    "UPDATE import_candidates SET match_status = 'discarded', reviewed_at = datetime('now'), reviewed_by = 'admin' WHERE id = ?",
  )
    .bind(id)
    .run();
  return json({ id, status: 'discarded' });
});

/**
 * Merge an import candidate into a target doctor/clinic (or promote it to a
 * brand-new published one if approvedAsNew=true). This is deliberately a
 * manual, explicit action — the pipeline never auto-publishes a conflicting
 * or low-confidence record.
 */
adminRoute.post('/import-candidates/:id/merge', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const targetId = typeof body.targetId === 'string' ? body.targetId : undefined;

  const candidate = await c.env.DB.prepare('SELECT * FROM import_candidates WHERE id = ?').bind(id).first<{
    id: string;
    entity_type: 'doctor' | 'clinic';
    raw_payload: string;
    source_name: string;
    source_url: string | null;
  }>();
  if (!candidate) return errorJson('Import candidate not found', 404);

  const payload = JSON.parse(candidate.raw_payload);
  const table = candidate.entity_type === 'doctor' ? 'doctors' : 'clinics';

  if (targetId) {
    // Merge into an existing record: mark it published/verified and append the source.
    const existing = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(targetId).first<{ sources?: string }>();
    if (!existing) return errorJson('Target record not found', 404);

    if (candidate.entity_type === 'doctor') {
      const sources: string[] = JSON.parse((existing as { sources?: string }).sources ?? '[]');
      if (!sources.includes(candidate.source_name)) sources.push(candidate.source_name);
      await c.env.DB.prepare(
        "UPDATE doctors SET status = 'published', verified = 1, sources = ?, last_verified_date = date('now'), updated_at = datetime('now') WHERE id = ?",
      )
        .bind(JSON.stringify(sources), targetId)
        .run();
    } else {
      await c.env.DB.prepare(
        "UPDATE clinics SET status = 'published', verified = 1, last_verified_date = date('now'), updated_at = datetime('now') WHERE id = ?",
      )
        .bind(targetId)
        .run();
    }

    await logVerification(c.env, candidate.entity_type, targetId, 'merged', 'admin', candidate.source_name, candidate.source_url ?? undefined);
  } else {
    // Promote as a brand-new published record.
    const newEntityId = newId(candidate.entity_type === 'doctor' ? 'doc' : 'clinic');
    if (candidate.entity_type === 'doctor') {
      await c.env.DB.prepare(
        `INSERT INTO doctors (id, name, specialty, primary_city, primary_province, contact_phone, status, verified, sources, last_verified_date)
         VALUES (?, ?, ?, ?, ?, ?, 'published', 1, ?, date('now'))`,
      )
        .bind(
          newEntityId,
          payload.name,
          payload.specialty ?? 'Developmental Pediatrician',
          payload.city ?? payload.primaryCity,
          payload.province ?? payload.primaryProvince,
          payload.phone ?? null,
          JSON.stringify([candidate.source_name]),
        )
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO clinics (id, name, city, province, address, phone, lat, lng, status, verified, last_verified_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', 1, date('now'))`,
      )
        .bind(newEntityId, payload.name, payload.city, payload.province, payload.address ?? '', payload.phone ?? null, payload.lat ?? null, payload.lng ?? null)
        .run();
    }
    await logVerification(c.env, candidate.entity_type, newEntityId, 'imported', 'admin', candidate.source_name, candidate.source_url ?? undefined);
  }

  await c.env.DB.prepare(
    "UPDATE import_candidates SET match_status = 'merged', matched_entity_id = ?, reviewed_at = datetime('now'), reviewed_by = 'admin' WHERE id = ?",
  )
    .bind(targetId ?? null, id)
    .run();

  await bumpGeneration(c.env, candidate.entity_type === 'doctor' ? 'doctors' : 'clinics');
  return json({ id, status: 'merged', targetId: targetId ?? null });
});

// --------------------------------------------------------------- pipeline --
/**
 * POST /api/admin/import/run
 * Manually triggers the same import pipeline as the Cron Trigger (see
 * src/importer/run.ts). Useful for testing a new source adapter without
 * waiting for the schedule.
 */
adminRoute.post('/import/run', async (c) => {
  const summaries = await runImport(c.env);
  return json({ summaries });
});

/**
 * GET /api/admin/import-logs
 * History of past import runs (one row per adapter per run), written by
 * runImport() in src/importer/run.ts. Optional ?status= filter
 * ('completed' | 'partial' | 'failed'); defaults to the most recent 200
 * runs across all sources/statuses.
 */
adminRoute.get('/import-logs', async (c) => {
  const status = c.req.query('status');
  const { results } = status
    ? await c.env.DB.prepare('SELECT * FROM import_logs WHERE status = ? ORDER BY started_at DESC LIMIT 200')
        .bind(status)
        .all()
    : await c.env.DB.prepare('SELECT * FROM import_logs ORDER BY started_at DESC LIMIT 200').all();
  return c.json(results ?? []);
});

adminRoute.get('/import-logs/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM import_logs WHERE id = ?').bind(id).first();
  if (!row) return errorJson('Import log not found', 404);
  return c.json(row);
});


async function logVerification(
  env: Env,
  entityType: 'doctor' | 'clinic',
  entityId: string,
  action: string,
  actor: string,
  sourceName?: string,
  sourceUrl?: string,
) {
  await env.DB.prepare(
    `INSERT INTO verification_logs (id, entity_type, entity_id, action, source_name, source_url, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('vlog'), entityType, entityId, action, sourceName ?? null, sourceUrl ?? null, JSON.stringify({ actor }))
    .run();
}

async function recomputeDoctorRating(env: Env, doctorId: string) {
  const agg = await env.DB.prepare(
    `SELECT AVG(rating) AS avg_rating, COUNT(*) AS n FROM reviews WHERE doctor_id = ? AND status = 'approved'`,
  )
    .bind(doctorId)
    .first<{ avg_rating: number | null; n: number }>();

  await env.DB.prepare("UPDATE doctors SET rating = ?, review_count = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(agg?.avg_rating ?? 0, agg?.n ?? 0, doctorId)
    .run();
}
