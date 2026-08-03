import type { ClinicDTO, ClinicRow, DoctorClinicRow, DoctorDTO, DoctorRow, ReviewDTO, ReviewRow } from '../types';

export function toDoctorDTO(row: DoctorRow, affiliations: DoctorClinicRow[]): DoctorDTO {
  let sources: string[] = [];
  try {
    sources = JSON.parse(row.sources || '[]');
  } catch {
    sources = [];
  }

  return {
    id: row.id,
    name: row.name,
    photo: row.photo_url,
    specialty: row.specialty,
    primaryCity: row.primary_city,
    primaryProvince: row.primary_province,
    contact: row.contact_phone,
    rating: Math.round(row.rating * 10) / 10,
    reviewCount: row.review_count,
    verified: !!row.verified,
    lastVerifiedDate: row.last_verified_date,
    sources,
    affiliations: affiliations.map((a) => ({
      clinicId: a.clinic_id,
      clinicName: a.clinic_name ?? '',
      schedule: a.schedule,
    })),
  };
}

export function toClinicDTO(row: ClinicRow, doctorCount: number): ClinicDTO {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    province: row.province,
    address: row.address,
    phone: row.phone,
    lat: row.lat,
    lng: row.lng,
    image: row.image,
    verified: !!row.verified,
    doctorCount,
    lastVerifiedDate: row.last_verified_date,
  };
}

export function toReviewDTO(row: ReviewRow): ReviewDTO {
  return {
    id: row.id,
    authorName: row.author_name,
    rating: row.rating,
    comment: row.comment,
    submittedAt: row.submitted_at,
  };
}
