import type { Env } from '../types';

/**
 * Verifies a Cloudflare Turnstile token against Cloudflare's siteverify endpoint.
 * In development, set SKIP_TURNSTILE="true" in wrangler.jsonc [vars] to bypass
 * (the frontend currently sends a hardcoded 'dev-placeholder-token' until the
 * real widget is wired up — see devped-ph-web/pages/doctor.js TODOs).
 */
export async function verifyTurnstile(env: Env, token: string | undefined, request: Request): Promise<boolean> {
  if (env.SKIP_TURNSTILE === 'true') return true;
  if (!token) return false;

  const ip = request.headers.get('CF-Connecting-IP') ?? undefined;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const outcome = (await res.json()) as { success: boolean };
    return outcome.success === true;
  } catch {
    // Fail closed: if Cloudflare's verification service is unreachable, reject the submission.
    return false;
  }
}
