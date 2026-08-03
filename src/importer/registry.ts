import type { SourceAdapter } from './types';
import { exampleSourceAdapter } from './sources/example-source';

/**
 * Every adapter listed here runs on each scheduled import (see
 * src/importer/run.ts) and each manual POST /api/admin/import/run.
 * Add real adapters (PSDBP listing, specific hospital directories,
 * Google Places, etc.) and list them here — nothing else needs to change.
 */
export const sourceAdapters: SourceAdapter[] = [exampleSourceAdapter];
