export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  RATE_LIMIT: KVNamespace;

  // Secrets (set with `wrangler secret put`)
  TURNSTILE_SECRET_KEY: string;
  ADMIN_API_KEY: string;

  // Plain vars (set in wrangler.jsonc [vars])
  ENVIRONMENT: 'development' | 'production';
  ALLOWED_ORIGINS: string; // comma-separated list
  SKIP_TURNSTILE?: string; // 'true' in dev only
}

export type EntityStatus = 'published' | 'pending_review' | 'rejected' | 'archived';

export interface DoctorRow {
  id: string;
  name: string;
  specialty: string;
  photo_url: string | null;
  primary_city: string;
  primary_province: string;
  contact_phone: string | null;
  contact_email: string | null;
  license_number: string | null;
  rating: number;
  review_count: number;
  verified: number;
  status: EntityStatus;
  sources: string; // JSON string
  last_verified_date: string | null;
  identity_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClinicRow {
  id: string;
  name: string;
  city: string;
  province: string;
  address: string;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  image: string | null;
  verified: number;
  status: EntityStatus;
  last_verified_date: string | null;
  identity_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface DoctorClinicRow {
  id: string;
  doctor_id: string;
  clinic_id: string;
  schedule: string | null;
  is_primary: number;
  clinic_name?: string;
}

export interface ReviewRow {
  id: string;
  doctor_id: string;
  author_name: string;
  rating: number;
  comment: string;
  status: 'pending' | 'approved' | 'rejected';
  submitted_at: string;
  moderated_at: string | null;
  moderated_by: string | null;
}

export interface ReportRow {
  id: string;
  doctor_id: string | null;
  clinic_id: string | null;
  reason: string;
  details: string | null;
  status: 'open' | 'reviewed' | 'resolved' | 'dismissed';
  submitted_at: string;
  resolved_at: string | null;
}

export interface ImportLogRow {
  id: string;
  source_name: string;
  doctors_fetched: number;
  doctors_auto_merged: number;
  doctors_created_pending: number;
  doctors_flagged_conflicting: number;
  clinics_fetched: number;
  clinics_auto_merged: number;
  clinics_created_pending: number;
  clinics_flagged_conflicting: number;
  errors: string; // JSON string array
  status: 'completed' | 'partial' | 'failed';
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

/** Shape returned to the frontend — matches devped-ph-web/components/api.js exactly. */

export interface DoctorDTO {
  id: string;
  name: string;
  photo: string | null;
  specialty: string;
  primaryCity: string;
  primaryProvince: string;
  contact: string | null;
  rating: number;
  reviewCount: number;
  verified: boolean;
  lastVerifiedDate: string | null;
  sources: string[];
  affiliations: { clinicId: string; clinicName: string; schedule: string | null }[];
}

export interface ClinicDTO {
  id: string;
  name: string;
  city: string;
  province: string;
  address: string;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  image: string | null;
  verified: boolean;
  doctorCount: number;
  lastVerifiedDate: string | null;
}

export interface ReviewDTO {
  id: string;
  authorName: string;
  rating: number;
  comment: string;
  submittedAt: string;
}
