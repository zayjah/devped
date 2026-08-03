# DevPed PH — API

Cloudflare Workers + D1 + KV backend for the [DevPed PH](../devped-ph-web)
frontend. Pure JSON REST API, no changes required to the frontend — it
already calls exactly these routes and falls back to mock data until this
Worker is live (see `components/api.js`).

## Stack

- **Cloudflare Workers** — compute, routed with [Hono](https://hono.dev)
- **D1** — SQLite-compatible database (doctors, clinics, reviews, reports,
  verification logs, import staging)
- **KV** — (1) read-through response cache, (2) rate limiting for public
  write endpoints
- **Turnstile** — bot protection on review/report submissions

## Project layout

```
src/
  index.ts              Hono app, route mounting, Cron Trigger entry point
  types.ts               Shared types (Env bindings, DB row shapes, DTOs)
  lib/
    mappers.ts            DB row -> frontend JSON shape
    cache.ts               KV read-through cache + generation-based invalidation
    cors.ts                 Origin allow-list
    ratelimit.ts            KV fixed-window rate limiter + IP hashing
    turnstile.ts             Cloudflare Turnstile server-side verification
    validation.ts             Zod schemas for POST bodies
    adminAuth.ts               Shared-secret auth for /api/admin/*
    utils.ts                    ids, hashing, fuzzy-matching helpers, JSON helpers
  routes/
    doctors.ts        GET /api/doctors, GET /api/doctors/:id
    clinics.ts          GET /api/clinics, GET /api/clinics/:id
    search.ts             GET /api/search?q=
    reviews.ts               GET /api/reviews/:doctorId, POST /api/reviews
    reports.ts                  POST /api/reports
    admin.ts                       /api/admin/* moderation + import review queue
    misc.ts                           GET /api/stats, GET /api/locations (bonus — see below)
  importer/
    types.ts                 SourceAdapter / RawDoctorRecord / RawClinicRecord
    match.ts                   Cross-matching + "Pending Review" staging logic
    run.ts                       Runs every registered adapter (cron + manual)
    registry.ts                    List of active source adapters
    sources/example-source.ts        Template — copy per real source
migrations/
  0001_init.sql            Schema: doctors, clinics, doctor_clinics, reviews,
                            reports, verification_logs, import_candidates
  0002_seed.sql              Optional seed data mirroring the frontend's mock data
  0003_import_logs.sql        Adds import_logs (one row per adapter per run)
test/
  apply-migrations.ts     Setup file — migrates the isolated test D1 DB
  unit/
    utils.test.ts             Pure helpers: hashing, ids, fuzzy matching
    match.test.ts               matchAndStageDoctor/Clinic against real D1
    run.test.ts                   runImport(): logging + error isolation
    admin-import.test.ts            /api/admin/import/* HTTP routes
vitest.config.ts
wrangler.jsonc
```

## 1. Endpoints

| Method | Path                     | Notes |
|--------|--------------------------|-------|
| GET    | `/api/doctors`           | Query: `query` (or `q`), `province`, `city`, `specialty`. Published only. |
| GET    | `/api/doctors/:id`       | 404 if not published. |
| GET    | `/api/clinics`           | Query: `city`. Published only. |
| GET    | `/api/clinics/:id`       | 404 if not published. |
| GET    | `/api/search?q=`         | FTS5 full-text search over doctors, LIKE fallback. |
| GET    | `/api/reviews/:doctorId` | Approved reviews only. |
| POST   | `/api/reviews`           | `{ doctorId, authorName?, rating, comment, turnstileToken }`. Rate-limited, Turnstile-verified, always inserted as `pending`. |
| POST   | `/api/reports`           | `{ doctorId? \| clinicId?, reason, details?, turnstileToken }`. Same protections. |
| GET    | `/api/stats`             | Bonus — matches `Api.getStats()` in the frontend. |
| GET    | `/api/locations`         | Bonus — matches `Api.getLocations()` in the frontend. |
| \*     | `/api/admin/*`           | Moderation dashboard API — see §6. Requires `X-Admin-Key`. |

`/api/stats` and `/api/locations` aren't in the original spec, but
`components/api.js` already calls them with a mock-data fallback — adding
them means the homepage stat grid and location chips go fully live too,
for free.

The frontend's `api.js` also calls `GET /api/doctors/:id/reviews` (not
`/api/reviews/:doctorId`). Both are equivalent from the pipeline's point of
view; if you want the exact URL the shipped frontend calls today, add a
one-line alias in `index.ts`:
```ts
app.get('/api/doctors/:id/reviews', (c) => reviewsRoute.fetch(
  new Request(c.req.url.replace(/\/doctors\/([^/]+)\/reviews/, '/reviews/$1')), c.env, c.executionCtx));
```
Simplest fix long-term: change `BASE_URL`'s caller in `api.js` to
`/api/reviews/${doctorId}` to match the task spec exactly — a one-line
frontend change if you'd rather not carry the alias.

All list/detail GETs are cached in KV (60–300s) and invalidated via a
generation counter bumped on every relevant write (see `lib/cache.ts`).

## 2. Data model

See `migrations/0001_init.sql` for full DDL. Highlights:

- **doctors** / **clinics** — `status` is one of `published`,
  `pending_review`, `rejected`, `archived`. **Only `published` rows are ever
  returned by the public API.** New imports, ambiguous matches, and
  freshly-submitted admin edits all start outside `published`.
- **doctor_clinics** — many-to-many join; a doctor can have several clinic
  affiliations, each with its own `schedule` text and an `is_primary` flag.
- **reviews** — always inserted `pending`; only `approved` rows are public.
  `doctors.rating` / `review_count` are recomputed from approved reviews
  whenever an admin approves one (`routes/admin.ts`).
- **reports** — free-text "report incorrect info", `open` → `resolved`.
- **verification_logs** — append-only audit trail: every import, match,
  conflict, manual approval/rejection, and merge writes a row here.
- **import_candidates** — staging table for the cross-matching pipeline
  (§5). Nothing here is public; it's only ever read by `/api/admin/*`.
- **import_logs** — one row per source adapter per import run (cron or
  manual). Tracks fetched/auto-merged/pending/conflicting counts per
  doctors/clinics, `status` (`completed`/`partial`/`failed`), and any
  errors, so a failed or partially-failed run is visible without digging
  through Worker logs. Written by `runImport()` (`importer/run.ts`), read
  via `/api/admin/import-logs`.

## 3. Local development

```bash
npm install

# Create D1 + KV resources once (see §4), then run migrations locally:
npm run db:migrate:local

cp .dev.vars.example .dev.vars
# edit .dev.vars — set ADMIN_API_KEY to anything for local use;
# TURNSTILE_SECRET_KEY doesn't matter locally since SKIP_TURNSTILE=true
# under `env.staging` in wrangler.jsonc (use `wrangler dev --env staging`
# to pick that up, or just set SKIP_TURNSTILE=true in your local vars).

npm run dev
# Worker runs at http://localhost:8787
```

Point the frontend at it by editing `devped-ph-web/components/api.js`:
```js
const BASE_URL = 'http://localhost:8787';
```
(Only for local testing — see §7 for production wiring, which requires no
frontend edits beyond this one line.)

## 4. Provisioning Cloudflare resources

```bash
npx wrangler login

# D1
npx wrangler d1 create devped-ph-db
# -> copy the returned database_id into wrangler.jsonc (d1_databases[0].database_id)

# KV
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create RATE_LIMIT
# -> copy both returned ids into wrangler.jsonc (kv_namespaces[*].id)

# Secrets (never go in wrangler.jsonc)
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put ADMIN_API_KEY
```

Get a Turnstile site key + secret key from the Cloudflare dashboard
(**Turnstile** in the sidebar) — the site key goes in the frontend widget
(still a TODO in `pages/doctor.js`), the secret key goes here.

## 5. Migrations

```bash
npm run db:migrate:remote      # applies migrations/*.sql to production D1
npm run db:migrate:staging     # same, against the staging DB (see wrangler.jsonc [env.staging])
```

`0002_seed.sql` mirrors `data/mock-data.js` so the live app looks identical
to the mock-data version immediately after deploy. Skip it (delete the file
before running migrations, or run `0001_init.sql` only) if you'd rather
start with an empty database and let the import pipeline populate it.

## 6. Admin API (backs `pages/admin.js`)

`pages/admin.js` ships as a **UI shell only** — its own comment says to put
`/admin` behind Cloudflare Access before wiring it to write endpoints. This
Worker exposes the endpoints it should call, all under `/api/admin/*`,
gated by a `X-Admin-Key` header for now:

- `GET /api/admin/doctors?status=pending_review`
- `POST /api/admin/doctors/:id/approve` / `/reject`
- `GET /api/admin/clinics?status=pending_review`
- `POST /api/admin/clinics/:id/approve` / `/reject`
- `GET /api/admin/reviews?status=pending`
- `POST /api/admin/reviews/:id/approve` / `/reject`
- `GET /api/admin/reports?status=open`
- `POST /api/admin/reports/:id/resolve`
- `GET /api/admin/import-candidates?status=conflicting`
- `POST /api/admin/import-candidates/:id/merge` — body `{ targetId? }`;
  merges into an existing record, or promotes to a brand-new published
  record if `targetId` is omitted
- `POST /api/admin/import-candidates/:id/discard`
- `POST /api/admin/import/run` — manually triggers the import pipeline;
  returns `{ summaries }`, one entry per adapter (see §7)
- `GET /api/admin/import-logs?status=` — history of past import runs
  (optional filter: `completed` | `partial` | `failed`)
- `GET /api/admin/import-logs/:id` — a single run's full detail

**Before going to production**, put the whole `/admin` path (frontend) and
`/api/admin/*` (this Worker) behind [Cloudflare
Access](https://developers.cloudflare.com/cloudflare-one/policies/access/).
The `X-Admin-Key` check in `lib/adminAuth.ts` is a stopgap — either delete
it once Access is enforcing auth at the edge, or keep it as
defense-in-depth and validate the `Cf-Access-Jwt-Assertion` header instead
of a shared secret.

## 7. Automatic import & cross-matching (`src/importer/`)

The pipeline never publishes anything directly:

1. Each **source adapter** (`importer/sources/*.ts`) fetches raw
   doctor/clinic records from one trusted source (hospital directory,
   PSDBP listing, Google Places, etc.) and shapes them into
   `RawDoctorRecord` / `RawClinicRecord` — no matching logic lives here.
2. `matchAndStageDoctor` / `matchAndStageClinic` (`importer/match.ts`)
   normalize the name + city and compare against existing rows:
   - **Exact identity-hash match, or a fuzzy match ≥ 0.92 similarity with a
     clear margin over the runner-up** → auto-merged: the source is
     appended to `sources`, `last_verified_date` bumped. The record's
     `status` is untouched (a `pending_review` row merged this way stays
     `pending_review` until an admin actually reviews it).
   - **Fuzzy match between 0.55–0.92, or multiple close candidates** → *not*
     applied to any doctors/clinics row. Instead it's written to
     `import_candidates` with `match_status='conflicting'` for a human to
     resolve via `/api/admin/import-candidates`.
   - **No plausible match at all** → inserted as a brand-new row with
     `status='pending_review'` (never `'published'`), and logged.
3. Every decision writes a `verification_logs` row for auditability.
4. An admin reviews the `/api/admin/import-candidates?status=conflicting`
   queue and either merges into an existing record or discards it; a
   `pending_review` doctor/clinic becomes visible on the public API only
   once an admin calls `/api/admin/doctors/:id/approve` (or `/clinics/:id/approve`).

To add a real source: copy `importer/sources/example-source.ts`, implement
`fetchDoctors()`/`fetchClinics()`, and add it to `importer/registry.ts`.

**Scheduling**: `wrangler.jsonc` sets a nightly Cron Trigger
(`triggers.crons: ["0 2 * * *"]`, 02:00 UTC). Adjust the cron expression to
taste, or trigger manually via `POST /api/admin/import/run`.

**Run history & error handling**: every adapter run writes an `import_logs`
row up front (`status='partial'`, `started_at` set) and finalizes it after
the run (`status='completed'|'partial'|'failed'`, counts, `errors` as a
JSON array, `finished_at`). Within one adapter, `fetchDoctors()` and
`fetchClinics()` fail independently — one directory being down doesn't stop
the other half of the same adapter, and one adapter throwing doesn't stop
the next adapter in the registry from running. Writing the log itself is
best-effort and never blocks the actual import (a KV/D1 hiccup while
logging is caught and only `console.error`'d). Inspect past runs via
`GET /api/admin/import-logs`.

## 8. Testing

```bash
npm install   # pulls in vitest + @cloudflare/vitest-pool-workers
npm test      # runs everything under test/ once
npm run test:watch
```

Tests run inside the actual Workers runtime (via `@cloudflare/vitest-pool-workers`,
configured in `vitest.config.ts`), against an isolated local D1 database that's
migrated fresh for every test file (`test/apply-migrations.ts`) — so
`test/unit/match.test.ts` and `test/unit/run.test.ts` exercise the real SQL in
`migrations/*.sql`, not a mock. `ADMIN_API_KEY`/`TURNSTILE_SECRET_KEY` are
overridden with fixed test values in `vitest.config.ts`; no real secrets or
`wrangler secret put` are needed to run the suite. Coverage:

- **utils.test.ts** — id generation, hashing, fuzzy-match scoring
- **match.test.ts** — `matchAndStageDoctor`/`Clinic`: new-record creation,
  exact auto-merge, ambiguous conflict flagging, cross-city non-collision
- **run.test.ts** — `runImport()`: `import_logs` persistence, partial vs.
  failed runs, one adapter's fetch failure not blocking another
- **admin-import.test.ts** — `/api/admin/import/run` and
  `/api/admin/import-logs[/:id]` over HTTP, including the `X-Admin-Key` gate

## 9. Deploying

```bash
npm run deploy              # production
npm run deploy:staging      # staging environment (see wrangler.jsonc [env.staging])
```

Then point the frontend at the deployed URL — the only change needed in
the entire `devped-ph-web` repo:

```js
// components/api.js
const BASE_URL = 'https://devped-ph-api.<your-subdomain>.workers.dev';
// or your custom domain, e.g. 'https://api.devped.ph', if you've mapped one
// with `wrangler deploy --routes` or a Worker Route in the dashboard.
```

Also update `ALLOWED_ORIGINS` in `wrangler.jsonc` to the real Cloudflare
Pages domain(s) the frontend is served from before deploying.

## 10. Security notes

- Public write endpoints (`/api/reviews`, `/api/reports`) require a valid
  Turnstile token, are rate-limited per IP (5/hour for reviews, 10/hour for
  reports, via KV), and reject exact-duplicate resubmissions from the same
  hashed IP within an hour.
- Raw IPs are never stored — only a salted SHA-256 hash, kept for abuse
  investigation and dedupe.
- CORS is restricted to `ALLOWED_ORIGINS`, not `*`, in production.
- All inputs are validated with Zod (`lib/validation.ts`) before touching
  the database; D1 queries are parameterized throughout (no string-built
  SQL from user input).
- `/api/admin/*` is not safe to expose as-is long-term — see §6.
