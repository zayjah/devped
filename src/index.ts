import { Hono } from 'hono';
import type { Env } from './types';
import { corsMiddleware } from './lib/cors';
import { errorJson } from './lib/utils';
import { doctorsRoute } from './routes/doctors';
import { clinicsRoute } from './routes/clinics';
import { searchRoute } from './routes/search';
import { reviewsRoute } from './routes/reviews';
import { reportsRoute } from './routes/reports';
import { adminRoute } from './routes/admin';
import { miscRoute } from './routes/misc';
import { runImport } from './importer/run';

const app = new Hono<{ Bindings: Env }>();

app.use('*', corsMiddleware());

app.get('/', (c) => c.json({ name: 'DevPed PH API', status: 'ok' }));
app.get('/health', (c) => c.json({ status: 'ok', environment: c.env.ENVIRONMENT }));

app.route('/api/doctors', doctorsRoute);
app.route('/api/clinics', clinicsRoute);
app.route('/api/search', searchRoute);
app.route('/api/reviews', reviewsRoute);
app.route('/api/reports', reportsRoute);
app.route('/api/admin', adminRoute);
app.route('/api', miscRoute); // /api/stats, /api/locations

app.notFound((c) => errorJson('Not found', 404));

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return errorJson('Internal server error', 500, c.env.ENVIRONMENT === 'development' ? { detail: String(err) } : {});
});

export default {
  fetch: app.fetch,

  /** Cron Trigger — see wrangler.jsonc [triggers.crons]. Runs the import/cross-matching pipeline. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runImport(env).then((summaries) => {
        console.log('Import run complete:', JSON.stringify(summaries));
      }),
    );
  },
};
