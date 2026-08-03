import { seedDatabase } from './seed.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function text(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

async function ensureSchema(db) {
  await db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clinics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      province TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      image TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      doctor_count INTEGER NOT NULL DEFAULT 0,
      last_verified_date TEXT
    );
    CREATE TABLE IF NOT EXISTS doctors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      specialty TEXT NOT NULL DEFAULT 'Developmental Pediatrician',
      primary_city TEXT NOT NULL,
      primary_province TEXT NOT NULL,
      contact TEXT NOT NULL,
      rating REAL NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 0,
      last_verified_date TEXT,
      sources_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS doctor_clinics (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      schedule TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved',
      submitted_at TEXT NOT NULL,
      moderated_at TEXT,
      moderator_notes TEXT
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_at TEXT NOT NULL,
      moderated_at TEXT,
      moderator_notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_clinics_city ON clinics(city);
    CREATE INDEX IF NOT EXISTS idx_clinics_province ON clinics(province);
    CREATE INDEX IF NOT EXISTS idx_clinics_status ON clinics(verified);
    CREATE INDEX IF NOT EXISTS idx_doctors_city ON doctors(primary_city);
    CREATE INDEX IF NOT EXISTS idx_doctors_province ON doctors(primary_province);
    CREATE INDEX IF NOT EXISTS idx_doctors_status ON doctors(verified);
    CREATE INDEX IF NOT EXISTS idx_doctor_clinics_doctor ON doctor_clinics(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_doctor_clinics_clinic ON doctor_clinics(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_doctor ON reviews(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
    CREATE INDEX IF NOT EXISTS idx_reports_doctor ON reports(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  `);

  const meta = await db.prepare(`SELECT value FROM meta WHERE key = 'bootstrap_done'`).first();
  if (!meta?.value) {
    await seedDatabase(db);
  }
}

async function all(db, sql, binds = []) {
  const stmt = db.prepare(sql);
  binds.forEach((b, i) => stmt.bind ? null : null);
  return await stmt.bind(...binds).all();
}

function rowToDoctor(row) {
  return {
    id: row.id,
    name: row.name,
    specialty: row.specialty,
    primaryCity: row.primary_city,
    primaryProvince: row.primary_province,
    contact: row.contact,
    rating: Number(row.rating),
    reviewCount: Number(row.review_count),
    verified: Boolean(row.verified),
    lastVerifiedDate: row.last_verified_date,
    sources: JSON.parse(row.sources_json || '[]'),
    affiliations: row.affiliations ? JSON.parse(row.affiliations) : [],
  };
}

function rowToClinic(row) {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    province: row.province,
    address: row.address,
    phone: row.phone,
    lat: Number(row.lat),
    lng: Number(row.lng),
    image: row.image,
    verified: Boolean(row.verified),
    doctorCount: Number(row.doctor_count),
    lastVerifiedDate: row.last_verified_date,
  };
}

async function getDoctors(db, filters = {}) {
  const clauses = [];
  const binds = [];
  if (filters.query) {
    clauses.push('(LOWER(d.name) LIKE ? OR LOWER(d.primary_city) LIKE ?)');
    const q = `%${filters.query.toLowerCase()}%`;
    binds.push(q, q);
  }
  if (filters.province && filters.province !== 'All') {
    clauses.push('d.primary_province = ?');
    binds.push(filters.province);
  }
  if (filters.city && filters.city !== 'All') {
    clauses.push('d.primary_city = ?');
    binds.push(filters.city);
  }
  if (filters.specialty) {
    clauses.push('d.specialty = ?');
    binds.push(filters.specialty);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const query = `
    SELECT
      d.*,
      COALESCE(
        json_group_array(
          json_object(
            'clinicId', c.id,
            'clinicName', c.name,
            'schedule', dc.schedule
          )
        ),
        json('[]')
      ) AS affiliations
    FROM doctors d
    LEFT JOIN doctor_clinics dc ON dc.doctor_id = d.id
    LEFT JOIN clinics c ON c.id = dc.clinic_id
    ${where}
    GROUP BY d.id
    ORDER BY d.verified DESC, d.rating DESC, d.name ASC
  `;
  const result = await db.prepare(query).bind(...binds).all();
  return result.results.map(rowToDoctor);
}

async function getDoctorById(db, id) {
  const doctor = await db.prepare(`SELECT * FROM doctors WHERE id = ?`).bind(id).first();
  if (!doctor) return null;
  const affiliations = await db.prepare(`
    SELECT c.id AS clinicId, c.name AS clinicName, dc.schedule
    FROM doctor_clinics dc
    JOIN clinics c ON c.id = dc.clinic_id
    WHERE dc.doctor_id = ?
    ORDER BY dc.is_primary DESC, c.name ASC
  `).bind(id).all();

  return rowToDoctor({
    ...doctor,
    affiliations: JSON.stringify(affiliations.results || []),
  });
}

async function getClinics(db, city) {
  const clauses = [];
  const binds = [];
  if (city && city !== 'All') {
    clauses.push('city = ?');
    binds.push(city);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db.prepare(`SELECT * FROM clinics ${where} ORDER BY verified DESC, name ASC`).bind(...binds).all();
  return result.results.map(rowToClinic);
}

async function getClinicById(db, id) {
  const row = await db.prepare(`SELECT * FROM clinics WHERE id = ?`).bind(id).first();
  return row ? rowToClinic(row) : null;
}

async function getReviews(db, doctorId) {
  const result = await db.prepare(`
    SELECT id, author_name AS authorName, rating, comment, submitted_at AS submittedAt
    FROM reviews
    WHERE doctor_id = ? AND status = 'approved'
    ORDER BY submitted_at DESC
  `).bind(doctorId).all();
  return result.results.map((r) => ({
    id: r.id,
    authorName: r.authorName,
    rating: Number(r.rating),
    comment: r.comment,
    submittedAt: r.submittedAt,
  }));
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) return json({ error: 'D1 binding DB missing' }, { status: 500 });

      await ensureSchema(env.DB);

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      const { pathname, searchParams } = url;

      if (pathname === '/api/health') {
        return json({ ok: true });
      }

      if (pathname === '/api/stats') {
        const verifiedClinics = await env.DB.prepare(`SELECT COUNT(*) AS count FROM clinics WHERE verified = 1`).first();
        const doctors = await env.DB.prepare(`SELECT COUNT(*) AS count FROM doctors`).first();
        const cities = await env.DB.prepare(`SELECT COUNT(DISTINCT city) AS count FROM clinics`).first();
        return json({
          verifiedClinics: Number(verifiedClinics?.count || 0),
          developmentalPediatricians: `${Number(doctors?.count || 0)}+`,
          citiesAndMunicipalities: Number(cities?.count || 0),
          childrenWithDisabilities: '5M+',
          childrenSource: 'iDinsight, 2025',
        });
      }

      if (pathname === '/api/locations') {
        const result = await env.DB.prepare(`SELECT DISTINCT city FROM clinics ORDER BY city ASC`).all();
        return json(result.results.map((r) => r.city));
      }

      if (pathname === '/api/clinics') {
        return json(await getClinics(env.DB, searchParams.get('city')));
      }

      if (pathname.startsWith('/api/clinics/')) {
        const id = pathname.split('/').filter(Boolean)[2];
        const clinic = await getClinicById(env.DB, id);
        if (!clinic) return json({ error: 'Clinic not found' }, { status: 404 });
        return json(clinic);
      }

      if (pathname === '/api/doctors') {
        return json(await getDoctors(env.DB, {
          query: searchParams.get('query') || '',
          province: searchParams.get('province') || '',
          city: searchParams.get('city') || '',
          specialty: searchParams.get('specialty') || '',
        }));
      }

      if (pathname.startsWith('/api/doctors/') && pathname.endsWith('/reviews')) {
        const id = pathname.split('/').filter(Boolean)[2];
        return json(await getReviews(env.DB, id));
      }

      if (pathname.startsWith('/api/doctors/')) {
        const id = pathname.split('/').filter(Boolean)[2];
        const doctor = await getDoctorById(env.DB, id);
        if (!doctor) return json({ error: 'Doctor not found' }, { status: 404 });
        return json(doctor);
      }

      if (pathname === '/api/reviews' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body?.doctorId || !body?.comment || !body?.rating) {
          return json({ error: 'Missing required fields' }, { status: 400 });
        }
        const id = `rev-${crypto.randomUUID()}`;
        await env.DB.prepare(`
          INSERT INTO reviews (id, doctor_id, author_name, rating, comment, status, submitted_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `).bind(id, body.doctorId, body.authorName || 'Anonymous', Number(body.rating), body.comment, new Date().toISOString().slice(0, 10)).run();
        return json({ ok: true, id });
      }

      if (pathname === '/api/reports' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body?.doctorId || !body?.reason || !body?.details) {
          return json({ error: 'Missing required fields' }, { status: 400 });
        }
        const id = `rep-${crypto.randomUUID()}`;
        await env.DB.prepare(`
          INSERT INTO reports (id, doctor_id, reason, details, status, submitted_at)
          VALUES (?, ?, ?, ?, 'pending', ?)
        `).bind(id, body.doctorId, body.reason, body.details, new Date().toISOString().slice(0, 10)).run();
        return json({ ok: true, id });
      }

      return text('Not found', { status: 404 });
    } catch (err) {
      return json({ error: err?.message || 'Internal error' }, { status: 500 });
    }
  },
};
