-- Optional seed data — mirrors devped-ph-web/data/mock-data.js so the app
-- looks identical the moment the Worker goes live. Safe to skip in prod
-- (see README §5) if you'd rather start empty and let the importer populate it.

INSERT OR IGNORE INTO clinics (id, name, city, province, address, phone, lat, lng, image, verified, status, last_verified_date, identity_hash) VALUES
('clinic-001', 'Chong Hua Hospital', 'Cebu City', 'Cebu', 'Fuente Osmeña Circle, Cebu City, Cebu', '+63 32 255 8000', 10.3111, 123.8917, 'https://images.unsplash.com/photo-1587351021355-a479a299d2f9?q=80&w=800&auto=format&fit=crop', 1, 'published', '2026-07-15', 'chong-hua-hospital|cebu-city'),
('clinic-002', 'Cebu Doctors'' University Hospital', 'Cebu City', 'Cebu', 'Osmeña Boulevard, Cebu City, Cebu', '+63 32 255 5555', 10.3055, 123.8925, 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?q=80&w=800&auto=format&fit=crop', 1, 'published', '2026-07-02', 'cebu-doctors-university-hospital|cebu-city'),
('clinic-003', 'Vicente Sotto Memorial Medical Center', 'Cebu City', 'Cebu', 'B. Rodriguez Street, Cebu City, Cebu', '+63 32 253 9891', 10.3048, 123.9021, 'https://images.unsplash.com/photo-1516549655169-df83a0774514?q=80&w=800&auto=format&fit=crop', 1, 'published', '2026-06-28', 'vicente-sotto-memorial-medical-center|cebu-city'),
('clinic-004', 'St. Luke''s Medical Center Global City', 'Taguig', 'Metro Manila', '32nd Street, Bonifacio Global City, Taguig', '+63 2 8789 7700', 14.5508, 121.0473, 'https://images.unsplash.com/photo-1587351021355-a479a299d2f9?q=80&w=800&auto=format&fit=crop', 1, 'published', '2026-07-20', 'st-lukes-medical-center-global-city|taguig'),
('clinic-005', 'Davao Doctors Hospital', 'Davao City', 'Davao del Sur', 'E. Quirino Avenue, Davao City', '+63 82 222 8000', 7.0722, 125.6131, 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?q=80&w=800&auto=format&fit=crop', 1, 'published', '2026-06-30', 'davao-doctors-hospital|davao-city');

INSERT OR IGNORE INTO doctors (id, name, specialty, primary_city, primary_province, contact_phone, rating, review_count, verified, status, sources, last_verified_date, identity_hash) VALUES
('doc-001', 'Dr. Maria Santos, MD', 'Developmental Pediatrician', 'Cebu City', 'Cebu', '+63 32 255 8000', 4.8, 24, 1, 'published', '["Chong Hua Hospital Directory","PSDBP Listing","Google Maps"]', '2026-07-15', 'dr-maria-santos-md|cebu-city'),
('doc-002', 'Dr. Jose Ramirez, MD, FPPS', 'Developmental Pediatrician', 'Cebu City', 'Cebu', '+63 32 255 5555', 4.9, 41, 1, 'published', '["Cebu Doctors'' University Hospital Directory","Official Clinic Website"]', '2026-07-02', 'dr-jose-ramirez-md-fpps|cebu-city'),
('doc-003', 'Dr. Angela Cruz, MD', 'Developmental Pediatrician', 'Taguig', 'Metro Manila', '+63 2 8789 7700', 4.7, 63, 1, 'published', '["Hospital Consultant Directory","Google Maps","PSDBP Listing"]', '2026-07-20', 'dr-angela-cruz-md|taguig');

INSERT OR IGNORE INTO doctor_clinics (id, doctor_id, clinic_id, schedule, is_primary) VALUES
('dc-001', 'doc-001', 'clinic-001', 'Mon, Wed, Fri · 1:00 PM – 4:00 PM', 1),
('dc-002', 'doc-002', 'clinic-002', 'Tue, Thu · 9:00 AM – 12:00 PM', 1),
('dc-003', 'doc-003', 'clinic-004', 'Mon–Fri · 2:00 PM – 5:00 PM', 1);

INSERT OR IGNORE INTO reviews (id, doctor_id, author_name, rating, comment, status, submitted_at, moderated_at, moderated_by) VALUES
('rev-001', 'doc-001', 'Parent of a 4-year-old', 5, 'Very patient with our son and explained the therapy plan clearly.', 'approved', '2026-06-10', '2026-06-11', 'seed'),
('rev-002', 'doc-001', 'Anonymous', 4, 'Long wait times but worth it. Highly knowledgeable.', 'approved', '2026-05-22', '2026-05-23', 'seed');
