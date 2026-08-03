import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';

/**
 * Minimal shared-secret auth for /api/admin/*.
 *
 * This is a stopgap, not the production auth story. The frontend's own
 * README says: "Put /admin behind Cloudflare Access (or your own auth)
 * before connecting it to write endpoints." In production, put this whole
 * route behind Cloudflare Access (or Access Service Tokens) at the zone
 * level and you can leave this middleware as defense-in-depth, or replace
 * it with validation of the Access-signed JWT (Cf-Access-Jwt-Assertion).
 */
export function requireAdmin(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const key = c.req.header('X-Admin-Key');
    if (!key || key !== c.env.ADMIN_API_KEY) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}
