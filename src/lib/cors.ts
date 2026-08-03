import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';

/**
 * Restrict cross-origin access to the configured allow-list
 * (Cloudflare Pages URL + custom domain), rather than "*".
 * ALLOWED_ORIGINS is a comma-separated wrangler var, e.g.
 * "https://devped.ph,https://www.devped.ph,https://devped-ph-web.pages.dev"
 */
export function corsMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.req.header('Origin') ?? '';
    const allowList = (c.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    const allowed = allowList.includes('*') || allowList.includes(origin);

    if (c.req.method === 'OPTIONS') {
      const headers = new Headers({
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
        'Access-Control-Max-Age': '86400',
      });
      if (allowed) headers.set('Access-Control-Allow-Origin', origin);
      return new Response(null, { status: 204, headers });
    }

    await next();

    if (allowed) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Vary', 'Origin');
    }
  };
}
