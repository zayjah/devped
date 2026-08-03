/** Generates a URL-safe id like "doc-9f3a1c2b" or "rev-7e21ab90". */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex}`;
}

/** SHA-256 hex digest — used for identity_hash (import matching) and ip_hash (privacy-safe rate limiting). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Normalizes a name/city for fuzzy identity matching: lowercase, strip titles/punctuation, collapse whitespace. */
export function normalizeForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(dr\.?|md|fpps|fppa|frcp|phd)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance — used by the importer to score near-duplicate names. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/** Similarity in [0,1], 1 = identical, based on normalized Levenshtein distance. */
export function similarity(a: string, b: string): number {
  const na = normalizeForMatching(a);
  const nb = normalizeForMatching(b);
  if (!na && !nb) return 1;
  const maxLen = Math.max(na.length, nb.length) || 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

export function errorJson(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, { status });
}
