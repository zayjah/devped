const clinics = [
  {
    id: 'clinic-001',
    name: 'Chong Hua Hospital',
    city: 'Cebu City',
    province: 'Cebu',
    address: 'Fuente Osmeña Circle, Cebu City, Cebu',
    phone: '+63 32 255 8000',
    lat: 10.3111,
    lng: 123.8917,
    image: 'https://images.unsplash.com/photo-1587351021355-a479a299d2f9?q=80&w=800&auto=format&fit=crop',
    verified: 1,
    doctor_count: 2,
    last_verified_date: '2026-07-15',
  },
  {
    id: 'clinic-002',
    name: "Cebu Doctors' University Hospital",
    city: 'Cebu City',
    province: 'Cebu',
    address: 'Osmeña Boulevard, Cebu City, Cebu',
    phone: '+63 32 255 5555',
    lat: 10.3055,
    lng: 123.8925,
    image: 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?q=80&w=800&auto=format&fit=crop',
    verified: 1,
    doctor_count: 1,
    last_verified_date: '2026-07-02',
  },
  {
    id: 'clinic-003',
    name: 'Vicente Sotto Memorial Medical Center',
    city: 'Cebu City',
    province: 'Cebu',
    address: 'B. Rodriguez Street, Cebu City, Cebu',
    phone: '+63 32 253 9891',
    lat: 10.3048,
    lng: 123.9021,
    image: 'https://images.unsplash.com/photo-1516549655169-df83a0774514?q=80&w=800&auto=format&fit=crop',
    verified: 1,
    doctor_count: 1,
    last_verified_date: '2026-06-28',
  },
  {
    id: 'clinic-004',
    name: "St. Luke's Medical Center Global City",
    city: 'Taguig',
    province: 'Metro Manila',
    address: '32nd Street, Bonifacio Global City, Taguig',
    phone: '+63 2 8789 7700',
    lat: 14.5508,
    lng: 121.0473,
    image: 'https://images.unsplash.com/photo-1587351021355-a479a299d2f9?q=80&w=800&auto=format&fit=crop',
    verified: 1,
    doctor_count: 4,
    last_verified_date: '2026-07-20',
  },
  {
    id: 'clinic-005',
    name: 'Davao Doctors Hospital',
    city: 'Davao City',
    province: 'Davao del Sur',
    address: 'E. Quirino Avenue, Davao City',
    phone: '+63 82 222 8000',
    lat: 7.0722,
    lng: 125.6131,
    image: 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?q=80&w=800&auto=format&fit=crop',
    verified: 1,
    doctor_count: 2,
    last_verified_date: '2026-06-30',
  },
];

const doctors = [
  {
    id: 'doc-001',
    name: 'Dr. Maria Santos, MD',
    specialty: 'Developmental Pediatrician',
    primary_city: 'Cebu City',
    primary_province: 'Cebu',
    contact: '+63 32 255 8000',
    rating: 4.8,
    review_count: 24,
    verified: 1,
    last_verified_date: '2026-07-15',
    sources_json: JSON.stringify(['Chong Hua Hospital Directory', 'PSDBP Listing', 'Google Maps']),
  },
  {
    id: 'doc-002',
    name: 'Dr. Jose Ramirez, MD, FPPS',
    specialty: 'Developmental Pediatrician',
    primary_city: 'Cebu City',
    primary_province: 'Cebu',
    contact: '+63 32 255 5555',
    rating: 4.9,
    review_count: 41,
    verified: 1,
    last_verified_date: '2026-07-02',
    sources_json: JSON.stringify(["Cebu Doctors' University Hospital Directory", 'Official Clinic Website']),
  },
  {
    id: 'doc-003',
    name: 'Dr. Angela Cruz, MD',
    specialty: 'Developmental Pediatrician',
    primary_city: 'Taguig',
    primary_province: 'Metro Manila',
    contact: '+63 2 8789 7700',
    rating: 4.7,
    review_count: 63,
    verified: 1,
    last_verified_date: '2026-07-20',
    sources_json: JSON.stringify(['Hospital Consultant Directory', 'Google Maps', 'PSDBP Listing']),
  },
];

const doctorClinics = [
  { id: 'dc-001', doctor_id: 'doc-001', clinic_id: 'clinic-001', schedule: 'Mon, Wed, Fri · 1:00 PM - 4:00 PM', is_primary: 1 },
  { id: 'dc-002', doctor_id: 'doc-002', clinic_id: 'clinic-002', schedule: 'Tue, Thu · 9:00 AM - 12:00 PM', is_primary: 1 },
  { id: 'dc-003', doctor_id: 'doc-003', clinic_id: 'clinic-004', schedule: 'Mon-Fri · 2:00 PM - 5:00 PM', is_primary: 1 },
];

const reviews = [
  {
    id: 'rev-001',
    doctor_id: 'doc-001',
    author_name: 'Parent of a 4-year-old',
    rating: 5,
    comment: 'Very patient with our son and explained the therapy plan clearly.',
    status: 'approved',
    submitted_at: '2026-06-10',
    moderated_at: '2026-06-11',
    moderator_notes: null,
  },
  {
    id: 'rev-002',
    doctor_id: 'doc-001',
    author_name: 'Anonymous',
    rating: 4,
    comment: 'Long wait times but worth it. Highly knowledgeable.',
    status: 'approved',
    submitted_at: '2026-05-22',
    moderated_at: '2026-05-23',
    moderator_notes: null,
  },
  {
    id: 'rev-003',
    doctor_id: 'doc-003',
    author_name: 'Parent of twins',
    rating: 5,
    comment: 'Clear explanations and very reassuring.',
    status: 'approved',
    submitted_at: '2026-06-18',
    moderated_at: '2026-06-19',
    moderator_notes: null,
  },
];

export async function seedDatabase(db) {
  const statements = [
    ...clinics.map((row) => db.prepare(
      `INSERT OR IGNORE INTO clinics (id, name, city, province, address, phone, lat, lng, image, verified, doctor_count, last_verified_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.name, row.city, row.province, row.address, row.phone, row.lat, row.lng, row.image, row.verified, row.doctor_count, row.last_verified_date)),
    ...doctors.map((row) => db.prepare(
      `INSERT OR IGNORE INTO doctors (id, name, specialty, primary_city, primary_province, contact, rating, review_count, verified, last_verified_date, sources_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.name, row.specialty, row.primary_city, row.primary_province, row.contact, row.rating, row.review_count, row.verified, row.last_verified_date, row.sources_json)),
    ...doctorClinics.map((row) => db.prepare(
      `INSERT OR IGNORE INTO doctor_clinics (id, doctor_id, clinic_id, schedule, is_primary)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(row.id, row.doctor_id, row.clinic_id, row.schedule, row.is_primary)),
    ...reviews.map((row) => db.prepare(
      `INSERT OR IGNORE INTO reviews (id, doctor_id, author_name, rating, comment, status, submitted_at, moderated_at, moderator_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.doctor_id, row.author_name, row.rating, row.comment, row.status, row.submitted_at, row.moderated_at, row.moderator_notes)),
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('bootstrap_done', '1')`),
  ];
  await db.batch(statements);
}
