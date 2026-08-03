import { Hono } from 'hono';
import type { Env } from '../types';
import { cached, cacheKey } from '../lib/cache';

/**
 * Not in the original endpoint spec, but devped-ph-web/components/api.js
 * already calls GET /api/stats and GET /api/locations (see getStats() /
 * getLocations()) and falls back to bundled mock data if these 404. Adding
 * them means the homepage stat grid and location chips go fully live too,
 * with zero frontend changes.
 */
export const miscRoute = new Hono<{ Bindings: Env }>();

miscRoute.get('/stats', async (c) => {
  const key = await cacheKey(c.env, 'stats', 'summary');
  const stats = await cached(c.env, key, 300, async () => {
    const doctors = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM doctors WHERE status = 'published'").first<{ n: number }>();
    const clinics = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM clinics WHERE status = 'published'").first<{ n: number }>();
    const cities = await c.env.DB.prepare(
      "SELECT COUNT(DISTINCT city) AS n FROM clinics WHERE status = 'published'",
    ).first<{ n: number }>();

    return {
      verifiedClinics: clinics?.n ?? 0,
      developmentalPediatricians: `${doctors?.n ?? 0}+`,
      citiesAndMunicipalities: cities?.n ?? 0,
      childrenWithDisabilities: '5M+',
      childrenSource: 'iDinsight, 2025',
    };
  });
  return c.json(stats);
});

miscRoute.get('/locations', async (c) => {
  const key = await cacheKey(c.env, 'clinics', 'locations');
  const locations = await cached(c.env, key, 300, async () => {
    const { results } = await c.env.DB.prepare(
      "SELECT DISTINCT city FROM clinics WHERE status = 'published' ORDER BY city ASC",
    ).all<{ city: string }>();
    return (results ?? []).map((r) => r.city);
  });
  return c.json(locations);
});
