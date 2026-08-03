import type { Env } from '../types';
import { sha256Hex } from './utils';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

/**
 * Simple fixed-window rate limiter backed by KV.
 * Keyed by a hash of (bucket + client IP) so raw IPs are never persisted.
 * KV writes are eventually consistent, which is an acceptable trade-off
 * for abuse throttling (not a security boundary) at this scale.
 */
export async function rateLimit(
  env: Env,
  request: Request,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const windowId = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${await sha256Hex(ip)}:${windowId}`;

  const current = Number((await env.RATE_LIMIT.get(key)) ?? '0');
  if (current >= limit) {
    return { allowed: false, remaining: 0, resetSeconds: windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds) };
  }

  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: windowSeconds + 5 });
  return { allowed: true, remaining: limit - current - 1, resetSeconds: windowSeconds };
}

/** Privacy-safe IP hash to store alongside reviews/reports for dedupe & abuse investigation. */
export async function hashIp(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return sha256Hex(`${env.ADMIN_API_KEY}:${ip}`); // salted with a server-only secret
}
