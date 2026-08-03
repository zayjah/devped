import { Hono } from 'hono';
import type { DoctorRow, Env } from '../types';
import { hydrateDoctors } from './doctors';
import { cached, cacheKey } from '../lib/cache';
import { errorJson } from '../lib/utils';

export const searchRoute = new Hono<{ Bindings: Env }>();

/**
 * GET /api/search?q=
 * Full-text search over published doctors (name / city / province) using
 * the doctors_fts virtual table, with a LIKE fallback for very short or
 * punctuation-only queries that FTS5 would otherwise reject.
 */
searchRoute.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return errorJson('Query parameter "q" is required', 400);

  const key = await cacheKey(c.env, 'doctors', `search:${q}`);

  const result = await cached(c.env, key, 60, async () => {
    let rows: DoctorRow[] = [];

    try {
      const ftsQuery = buildFtsQuery(q);
      const { results } = await c.env.DB.prepare(
        `SELECT d.* FROM doctors d
         JOIN doctors_fts f ON f.id = d.id
         WHERE f MATCH ? AND d.status = 'published'
         ORDER BY f.rank
         LIMIT 50`,
      )
        .bind(ftsQuery)
        .all<DoctorRow>();
      rows = results ?? [];
    } catch {
      // FTS5 MATCH syntax errors on some inputs (bare punctuation, etc.) — fall back to LIKE.
      rows = [];
    }

    if (rows.length === 0) {
      const { results } = await c.env.DB.prepare(
        `SELECT * FROM doctors
         WHERE status = 'published' AND (name LIKE ? OR primary_city LIKE ? OR primary_province LIKE ?)
         ORDER BY rating DESC LIMIT 50`,
      )
        .bind(`%${q}%`, `%${q}%`, `%${q}%`)
        .all<DoctorRow>();
      rows = results ?? [];
    }

    return hydrateDoctors(c.env, rows);
  });

  return c.json(result);
});

/** Turns free text into a prefix-matched FTS5 query, e.g. "maria san" -> `"maria"* "san"*`. */
function buildFtsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) throw new Error('empty query');
  return tokens.map((t) => `"${t}"*`).join(' ');
}
