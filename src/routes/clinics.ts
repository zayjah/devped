import { Hono } from 'hono';
import type { ClinicRow, Env } from '../types';
import { toClinicDTO } from '../lib/mappers';
import { cached, cacheKey } from '../lib/cache';
import { errorJson } from '../lib/utils';

export const clinicsRoute = new Hono<{ Bindings: Env }>();

/** GET /api/clinics?city= */
clinicsRoute.get('/', async (c) => {
  const city = c.req.query('city') ?? '';
  const key = await cacheKey(c.env, 'clinics', `list:${city}`);

  const result = await cached(c.env, key, 120, async () => {
    const conditions: string[] = ["status = 'published'"];
    const params: unknown[] = [];
    if (city && city !== 'All') {
      conditions.push('city = ?');
      params.push(city);
    }

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM clinics WHERE ${conditions.join(' AND ')} ORDER BY name ASC LIMIT 200`,
    )
      .bind(...params)
      .all<ClinicRow>();

    return hydrateClinics(c.env, results ?? []);
  });

  return c.json(result);
});

/** GET /api/clinics/:id */
clinicsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const key = await cacheKey(c.env, 'clinics', `detail:${id}`);

  const clinic = await cached(c.env, key, 120, async () => {
    const row = await c.env.DB.prepare("SELECT * FROM clinics WHERE id = ? AND status = 'published'")
      .bind(id)
      .first<ClinicRow>();
    if (!row) return null;
    const [dto] = await hydrateClinics(c.env, [row]);
    return dto;
  });

  if (!clinic) return errorJson('Clinic not found', 404);
  return c.json(clinic);
});

export async function hydrateClinics(env: Env, rows: ClinicRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const { results } = await env.DB.prepare(
    `SELECT clinic_id, COUNT(*) AS n FROM doctor_clinics
     WHERE clinic_id IN (${placeholders})
     GROUP BY clinic_id`,
  )
    .bind(...ids)
    .all<{ clinic_id: string; n: number }>();

  const counts = new Map((results ?? []).map((r) => [r.clinic_id, r.n]));
  return rows.map((row) => toClinicDTO(row, counts.get(row.id) ?? 0));
}
