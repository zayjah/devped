/** A single doctor record as scraped/fetched from a trusted external source, before matching. */
export interface RawDoctorRecord {
  name: string;
  specialty?: string;
  city: string;
  province: string;
  phone?: string;
  email?: string;
  licenseNumber?: string;
  clinicName?: string; // affiliation hint, matched against clinics.name if present
  sourceUrl?: string;
}

/** A single clinic record as scraped/fetched from a trusted external source, before matching. */
export interface RawClinicRecord {
  name: string;
  city: string;
  province: string;
  address: string;
  phone?: string;
  lat?: number;
  lng?: number;
  sourceUrl?: string;
}

/**
 * A trusted-source adapter. Each adapter is responsible only for fetching
 * and shaping raw records — never for deciding what gets published. That
 * decision always goes through matchAndStage() in match.ts.
 */
export interface SourceAdapter {
  /** Stable name shown in doctors.sources / verification_logs.source_name, e.g. "PSDBP Listing". */
  name: string;
  fetchDoctors?(): Promise<RawDoctorRecord[]>;
  fetchClinics?(): Promise<RawClinicRecord[]>;
}

export interface MatchDecision {
  outcome: 'auto_merged' | 'created_pending' | 'flagged_conflicting';
  confidence: number;
  matchedEntityId: string | null;
  candidateId: string;
}
