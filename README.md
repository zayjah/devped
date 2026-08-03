# DevPed PH Worker

Serves both the API (`/api/*`) and the static frontend (everything else) from
one Worker, bound to your existing D1 database `devped-ph-db`.

## Deploy

```bash
cd worker
npx wrangler login          # first time only
npx wrangler deploy
```

This deploys to `https://devped.<your-subdomain>.workers.dev` — the `name`
field in `wrangler.toml` is what controls that subdomain, so don't rename it
unless you also update `BASE_URL` in `devped-ph-web/components/api.js`.

## Admin token (optional but recommended)

To protect the admin write endpoints (create/edit/delete clinics & doctors,
approve/reject reviews, resolve reports):

```bash
npx wrangler secret put ADMIN_TOKEN
# paste a long random value when prompted
```

Then, in the app, open **More → Admin Dashboard** and paste the same value
into the "Admin token" field at the top before making changes.

If you never set `ADMIN_TOKEN`, the admin write endpoints stay open to
anyone who knows the URL — fine for local testing, not for a public site.

## Schema

The API auto-creates the schema and seeds a handful of sample rows on the
very first request, but only if the `meta.bootstrap_done` flag is missing —
it will not touch or duplicate data you've already loaded into the existing
`devped-ph-db` database.

## Verifying it's working

After deploying, check these directly in a browser:

- `https://devped.rjezm-tadlas.workers.dev/api/health` → `{"ok":true}`
- `https://devped.rjezm-tadlas.workers.dev/api/clinics` → a JSON array with
  ALL of your clinic rows (no limit is applied anywhere in this Worker)
- `https://devped.rjezm-tadlas.workers.dev/` → the app itself

If `/api/clinics` returns fewer rows than you expect, the problem is in the
D1 database contents (e.g. rows in a differently-named table), not this
Worker — every query here is `SELECT * FROM clinics` / `SELECT * FROM
doctors` with no `LIMIT`.
