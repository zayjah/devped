import { Hono } from 'hono';
import type { DoctorRow, Env, ReviewRow } from '../types';
import { toReviewDTO } from '../lib/mappers';
import { cached, cacheKey, bumpGeneration } from '../lib/cache';
import { errorJson, json, newId } from '../lib/utils';
import { rateLimit, hashIp } from '../lib/ratelimit';
import { verifyTurnstile } from '../lib/turnstile';
import { ReviewInputSchema } from '../lib/validation';

export const reviewsRoute = new Hono<{ Bindings: Env }>();

/** GET /api/reviews/:doctorId — approved reviews only, newest first. */
reviewsRoute.get('/:doctorId', async (c) => {
  const doctorId = c.req.param('doctorId');
  const key = await cacheKey(c.env, 'reviews', doctorId);

  const reviews = await cached(c.env, key, 60, async () => {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM reviews WHERE doctor_id = ? AND status = 'approved' ORDER BY submitted_at DESC LIMIT 100`,
    )
      .bind(doctorId)
      .all<ReviewRow>();
    return (results ?? []).map(toReviewDTO);
  });

  return c.json(reviews);
});

/**
 * POST /api/reviews
 * Body: { doctorId, authorName?, rating, comment, turnstileToken }
 * Always inserted as status='pending' — an admin (or auto-moderation rule)
 * must approve before it appears in GET /api/reviews/:doctorId.
 */
reviewsRoute.post('/', async (c) => {
  const limited = await rateLimit(c.env, c.req.raw, 'submit-review', 5, 3600);
  if (!limited.allowed) {
    return errorJson('Too many submissions. Please try again later.', 429, { retryAfterSeconds: limited.resetSeconds });
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return errorJson('Invalid JSON body', 400);

  const parsed = ReviewInputSchema.safeParse(body);
  if (!parsed.success) {
    return errorJson('Invalid review', 422, { issues: parsed.error.flatten() });
  }
  const input = parsed.data;

  const doctor = await c.env.DB.prepare("SELECT id FROM doctors WHERE id = ? AND status = 'published'")
    .bind(input.doctorId)
    .first<Pick<DoctorRow, 'id'>>();
  if (!doctor) return errorJson('Doctor not found', 404);

  const humanVerified = await verifyTurnstile(c.env, input.turnstileToken, c.req.raw);
  if (!humanVerified) return errorJson('Human verification failed', 403);

  const ipHash = await hashIp(c.req.raw, c.env);

  // Soft duplicate guard: same doctor + same IP hash + identical comment within the last hour.
  const dup = await c.env.DB.prepare(
    `SELECT id FROM reviews WHERE doctor_id = ? AND ip_hash = ? AND comment = ? AND submitted_at > datetime('now','-1 hour')`,
  )
    .bind(input.doctorId, ipHash, input.comment)
    .first();
  if (dup) return errorJson('Duplicate submission detected', 409);

  const id = newId('rev');
  await c.env.DB.prepare(
    `INSERT INTO reviews (id, doctor_id, author_name, rating, comment, status, ip_hash)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, input.doctorId, input.authorName || 'Anonymous', input.rating, input.comment, ipHash)
    .run();

  // Reviews cache doesn't need to change (pending reviews aren't shown), but
  // bump anyway in case an admin approval endpoint races with this request.
  await bumpGeneration(c.env, 'reviews');

  return json({ id, status: 'pending', message: 'Thanks! Your review is pending admin approval.' }, { status: 201 });
});
