import type { Env } from '../types';
import { newId } from '../lib/utils';
import { sourceAdapters as defaultAdapters } from './registry';
import { matchAndStageClinic, matchAndStageDoctor } from './match';
import type { RawClinicRecord, RawDoctorRecord, SourceAdapter } from './types';

export interface ImportRunSummary {
  /** Row id in import_logs — use this to look up the persisted run later. */
  logId: string;
  source: string;
  doctors: { fetched: number; autoMerged: number; createdPending: number; flaggedConflicting: number };
  clinics: { fetched: number; autoMerged: number; createdPending: number; flaggedConflicting: number };
  errors: string[];
  /**
   * completed: no errors.
   * partial: some records were fetched/staged, but at least one error occurred
   *          (a single bad record, or one of fetchDoctors/fetchClinics failing
   *          while the other succeeded).
   * failed: nothing was fetched at all.
   */
  status: 'completed' | 'partial' | 'failed';
}

/**
 * Runs every registered source adapter, cross-matches each record against
 * the existing database, and stages the result. Never publishes anything
 * directly — see match.ts for the confidence thresholds that decide
 * auto-merge vs. "Pending Review" vs. "needs a human to resolve a conflict".
 *
 * Every run (one per adapter) is persisted to `import_logs` so past runs can
 * be inspected via GET /api/admin/import-logs, independent of whether the
 * triggering request/cron is still around to see the return value.
 *
 * `adapters` defaults to the registry but can be overridden — this is what
 * lets tests exercise the pipeline against fixture adapters instead of real
 * network calls.
 */
export async function runImport(env: Env, adapters: SourceAdapter[] = defaultAdapters): Promise<ImportRunSummary[]> {
  const summaries: ImportRunSummary[] = [];

  for (const adapter of adapters) {
    const summary: ImportRunSummary = {
      logId: newId('implog'),
      source: adapter.name,
      doctors: { fetched: 0, autoMerged: 0, createdPending: 0, flaggedConflicting: 0 },
      clinics: { fetched: 0, autoMerged: 0, createdPending: 0, flaggedConflicting: 0 },
      errors: [],
      status: 'completed',
    };

    await startImportLog(env, summary).catch((err) => {
      // A logging failure must never block the actual import work.
      console.error(`import_logs: failed to write start row for "${adapter.name}":`, err);
    });

    // fetchDoctors and fetchClinics are isolated from each other: one
    // source's directory being down shouldn't stop the other half of the
    // same adapter (or any other adapter) from running.
    if (adapter.fetchDoctors) {
      await runDoctorImport(env, adapter, summary);
    }

    if (adapter.fetchClinics) {
      await runClinicImport(env, adapter, summary);
    }

    const totalFetched = summary.doctors.fetched + summary.clinics.fetched;
    summary.status = summary.errors.length === 0 ? 'completed' : totalFetched > 0 ? 'partial' : 'failed';

    await finishImportLog(env, summary).catch((err) => {
      console.error(`import_logs: failed to write finish row for "${adapter.name}":`, err);
    });

    summaries.push(summary);
  }

  return summaries;
}

async function runDoctorImport(env: Env, adapter: SourceAdapter, summary: ImportRunSummary): Promise<void> {
  let doctors: RawDoctorRecord[];
  try {
    doctors = (await adapter.fetchDoctors!()) ?? [];
  } catch (err) {
    summary.errors.push(`fetchDoctors failed: ${(err as Error).message}`);
    return;
  }

  summary.doctors.fetched = doctors.length;
  for (const record of doctors) {
    try {
      const decision = await matchAndStageDoctor(env, record, adapter.name);
      if (decision.outcome === 'auto_merged') summary.doctors.autoMerged++;
      else if (decision.outcome === 'created_pending') summary.doctors.createdPending++;
      else summary.doctors.flaggedConflicting++;
    } catch (err) {
      summary.errors.push(`doctor "${record.name}": ${(err as Error).message}`);
    }
  }
}

async function runClinicImport(env: Env, adapter: SourceAdapter, summary: ImportRunSummary): Promise<void> {
  let clinics: RawClinicRecord[];
  try {
    clinics = (await adapter.fetchClinics!()) ?? [];
  } catch (err) {
    summary.errors.push(`fetchClinics failed: ${(err as Error).message}`);
    return;
  }

  summary.clinics.fetched = clinics.length;
  for (const record of clinics) {
    try {
      const decision = await matchAndStageClinic(env, record, adapter.name);
      if (decision.outcome === 'auto_merged') summary.clinics.autoMerged++;
      else if (decision.outcome === 'created_pending') summary.clinics.createdPending++;
      else summary.clinics.flaggedConflicting++;
    } catch (err) {
      summary.errors.push(`clinic "${record.name}": ${(err as Error).message}`);
    }
  }
}

async function startImportLog(env: Env, summary: ImportRunSummary): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO import_logs (id, source_name, status, started_at) VALUES (?, ?, 'partial', datetime('now'))`,
  )
    .bind(summary.logId, summary.source)
    .run();
}

async function finishImportLog(env: Env, summary: ImportRunSummary): Promise<void> {
  await env.DB.prepare(
    `UPDATE import_logs SET
       doctors_fetched = ?, doctors_auto_merged = ?, doctors_created_pending = ?, doctors_flagged_conflicting = ?,
       clinics_fetched = ?, clinics_auto_merged = ?, clinics_created_pending = ?, clinics_flagged_conflicting = ?,
       errors = ?, status = ?, finished_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      summary.doctors.fetched,
      summary.doctors.autoMerged,
      summary.doctors.createdPending,
      summary.doctors.flaggedConflicting,
      summary.clinics.fetched,
      summary.clinics.autoMerged,
      summary.clinics.createdPending,
      summary.clinics.flaggedConflicting,
      JSON.stringify(summary.errors),
      summary.status,
      summary.logId,
    )
    .run();
}
