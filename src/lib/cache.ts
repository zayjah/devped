import type { Env } from '../types';

const DEFAULT_TTL_SECONDS = 120;

/** Read-through cache: return cached JSON if present, otherwise compute, cache, and return it. */
export async function cached<T>(env: Env, key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const hit = await env.CACHE.get(key, 'json');
  if (hit !== null) return hit as T;

  const value = await compute();
  // Don't let a cache write failure break the response.
  env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds || DEFAULT_TTL_SECONDS }).catch(() => {});
  return value;
}

/**
 * Invalidate cached list/detail responses after a write. KV has no native
 * "delete by prefix", so writes are tagged with a cache "generation" number
 * that's bumped on every mutation — see bumpGeneration/cacheKey below.
 */
export async function bumpGeneration(env: Env, namespace: string): Promise<void> {
  await env.CACHE.put(`gen:${namespace}`, String(Date.now()));
}

export async function cacheKey(env: Env, namespace: string, suffix: string): Promise<string> {
  const gen = (await env.CACHE.get(`gen:${namespace}`)) ?? '0';
  return `${namespace}:${gen}:${suffix}`;
}
