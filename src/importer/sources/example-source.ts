import type { RawClinicRecord, RawDoctorRecord, SourceAdapter } from '../types';

/**
 * Template adapter. Duplicate this file per trusted source (PSDBP listing,
 * a specific hospital's consultant directory, Google Places, etc.) and
 * register it in src/importer/registry.ts.
 *
 * Keep adapters "dumb": fetch + shape only. All matching/merge/publish
 * decisions live in match.ts so every source is held to the same bar.
 */
export const exampleSourceAdapter: SourceAdapter = {
  name: 'Example Trusted Source',

  async fetchDoctors(): Promise<RawDoctorRecord[]> {
    // Replace with a real fetch() against the source, e.g.:
    // const res = await fetch('https://example-hospital.ph/directory.json');
    // const data = await res.json();
    // return data.map((d) => ({ name: d.fullName, city: d.city, province: d.province, ... }));
    return [];
  },

  async fetchClinics(): Promise<RawClinicRecord[]> {
    return [];
  },
};
