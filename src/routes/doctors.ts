import { Hono } from 'hono';
import type { DoctorClinicRow, DoctorRow, Env } from '../types';
import { toDoctorDTO } from '../lib/mappers';
import { cached, cacheKey } from '../lib/cache';
import { errorJson } from '../lib/utils';

export const doctorsRoute = new Hono<{ Bindings: Env }>();

/**
 * GET /api/doctors?query=&province=&city=&specialty=
 * Only ever returns status='published' rows — pending/rejected/archived
 * records are invisible to the public API by construction.
 */
doctorsRoute.get('/', async (c) => {
  const query = (c.req.query('query') ?? c.req.query('q') ?? '').trim();
  const province = c.req.query('province') ?? '';
  const city = c.req.query('city') ?? '';
  const specialty = c.req.query('specialty') ?? '';

  const key = await cacheKey(c.env, 'doctors', JSON.stringify({ query, province, city, specialty }));

  const result = await cached(c.env, key, 60, async () => {
    const conditions: string[] = ["status = 'published'"];
    const params: unknown[] = [];

    if (query) {
      conditions.push('(name LIKE ? OR primary_city LIKE ?)');
      params.push(`%${query}%`, `%${query}%`);
    }
    if (province && province !== 'All') {
      conditions.push('primary_province = ?');
      params.push(province);
    }
    if (city && city !== 'All') {
      conditions.push('primary_city = ?');
      params.push(city);
    }
    if (specialty) {
      conditions.push('specialty = ?');
      params.push(specialty);
    }

    const sql = `SELECT * FROM doctors WHERE ${conditions.join(' AND ')} ORDER BY rating DESC, review_count DESC LIMIT 200`;
    const { results } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<DoctorRow>();

    return hydrateDoctors(c.env, results ?? []);
  });

  return c.json(result);
});

/** GET /api/doctors/:id */
doctorsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const key = await cacheKey(c.env, 'doctors', `detail:${id}`);

  const doctor = await cached(c.env, key, 120, async () => {
    const row = await c.env.DB.prepare("SELECT * FROM doctors WHERE id = ? AND status = 'published'")
      .bind(id)
      .first<DoctorRow>();
    if (!row) return null;
    const [dto] = await hydrateDoctors(c.env, [row]);
    return dto;
  });

  if (!doctor) return errorJson('Doctor not found', 404);
  return c.json(doctor);
});

/** Attaches clinic affiliations to a batch of doctor rows in one query (avoids N+1). */
export async function hydrateDoctors(env: Env, rows: DoctorRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const { results } = await env.DB.prepare(
    `SELECT dc.id, dc.doctor_id, dc.clinic_id, dc.schedule, dc.is_primary, cl.name AS clinic_name
     FROM doctor_clinics dc
     JOIN clinics cl ON cl.id = dc.clinic_id
     WHERE dc.doctor_id IN (${placeholders})
     ORDER BY dc.is_primary DESC`,
  )
    .bind(...ids)
    .all<DoctorClinicRow>();

  const byDoctor = new Map<string, DoctorClinicRow[]>();
  for (const row of results ?? []) {
    const list = byDoctor.get(row.doctor_id) ?? [];
    list.push(row);
    byDoctor.set(row.doctor_id, list);
  }

  return rows.map((row) => toDoctorDTO(row, byDoctor.get(row.id) ?? []));
}
