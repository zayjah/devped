import { Hono } from 'hono';
import type { Env } from '../types';
import { errorJson, json, newId } from '../lib/utils';
import { rateLimit, hashIp } from '../lib/ratelimit';
import { verifyTurnstile } from '../lib/turnstile';
import { ReportInputSchema } from '../lib/validation';

export const reportsRoute = new Hono<{ Bindings: Env }>();

/**
 * POST /api/reports
 * Body: { doctorId? | clinicId?, reason, details?, turnstileToken }
 * Always inserted as status='open' for an admin to triage.
 */
reportsRoute.post('/', async (c) => {
  const limited = await rateLimit(c.env, c.req.raw, 'submit-report', 10, 3600);
  if (!limited.allowed) {
    return errorJson('Too many submissions. Please try again later.', 429, { retryAfterSeconds: limited.resetSeconds });
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return errorJson('Invalid JSON body', 400);

  const parsed = ReportInputSchema.safeParse(body);
  if (!parsed.success) {
    return errorJson('Invalid report', 422, { issues: parsed.error.flatten() });
  }
  const input = parsed.data;

  if (input.doctorId) {
    const doctor = await c.env.DB.prepare('SELECT id FROM doctors WHERE id = ?').bind(input.doctorId).first();
    if (!doctor) return errorJson('Doctor not found', 404);
  }
  if (input.clinicId) {
    const clinic = await c.env.DB.prepare('SELECT id FROM clinics WHERE id = ?').bind(input.clinicId).first();
    if (!clinic) return errorJson('Clinic not found', 404);
  }

  const humanVerified = await verifyTurnstile(c.env, input.turnstileToken, c.req.raw);
  if (!humanVerified) return errorJson('Human verification failed', 403);

  const ipHash = await hashIp(c.req.raw, c.env);
  const id = newId('rpt');

  await c.env.DB.prepare(
    `INSERT INTO reports (id, doctor_id, clinic_id, reason, details, status, ip_hash)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(id, input.doctorId ?? null, input.clinicId ?? null, input.reason, input.details ?? '', ipHash)
    .run();

  return json(
    { id, status: 'open', message: 'Report submitted. Thank you for helping keep DevPed PH accurate.' },
    { status: 201 },
  );
});
