import { seedDatabase } from './seed.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
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

// Admin routes are gated by X-Admin-Token when env.ADMIN_TOKEN is configured
// (Workers > Settings > Variables). If ADMIN_TOKEN is not set, admin routes
// are left open — set it before sharing this URL with anyone else.
function isAdminAuthed(request, env) {
  if (!env.ADMIN_TOKEN) return true;
  return request.headers.get('X-Admin-Token') === env.ADMIN_TOKEN;
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

function rowToDoctor(row) {
  return {
    id: row.id,
    name: row.name,
    specialty: row.specialty,
    primaryCity: row.primary_city,
    primaryProvince: row.primary_province,
    contact: row.contact,
    rating: Number(row.rating || 0),
    reviewCount: Number(row.review_count || 0),
    verified: Boolean(row.verified),
    lastVerifiedDate: row.last_verified_date,
    sources: JSON.parse(row.sources_json || '[]'),
    // LEFT JOIN with no matching clinic still produces one placeholder row
    // (clinicId: null) via json_group_array — drop those before returning.
    affiliations: (row.affiliations ? JSON.parse(row.affiliations) : []).filter((a) => a && a.clinicId != null),
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
    doctorCount: Number(row.doctor_count || 0),
    lastVerifiedDate: row.last_verified_date,
  };
}

// NOTE: no LIMIT is applied anywhere below — every clinic/doctor row in the
// database is returned. If you have hundreds of rows and only see a handful
// in the app, the problem is on the frontend (or the request never reaching
// this Worker), not here.

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
    clauses.push('c.city = ?');
    binds.push(city);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // doctor_count is computed live from doctor_clinics so it never drifts out
  // of sync with reality, regardless of what was typed into that column.
  const result = await db.prepare(`
    SELECT c.*, COUNT(dc.doctor_id) AS live_doctor_count
    FROM clinics c
    LEFT JOIN doctor_clinics dc ON dc.clinic_id = c.id
    ${where}
    GROUP BY c.id
    ORDER BY c.verified DESC, c.name ASC
  `).bind(...binds).all();
  return result.results.map((r) => rowToClinic({ ...r, doctor_count: r.live_doctor_count }));
}

async function getClinicById(db, id) {
  const row = await db.prepare(`
    SELECT c.*, COUNT(dc.doctor_id) AS live_doctor_count
    FROM clinics c
    LEFT JOIN doctor_clinics dc ON dc.clinic_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).bind(id).first();
  return row ? rowToClinic({ ...row, doctor_count: row.live_doctor_count }) : null;
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

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function handleApi(request, env, url) {
  const { pathname, searchParams } = url;
  const method = request.method;

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

  // ---- Clinics ----
  if (pathname === '/api/clinics' && method === 'GET') {
    return json(await getClinics(env.DB, searchParams.get('city')));
  }

  if (pathname === '/api/clinics' && method === 'POST') {
    if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
    const b = await request.json().catch(() => null);
    if (!b?.name || !b?.city || !b?.province || !b?.address || !b?.phone) {
      return json({ error: 'Missing required fields (name, city, province, address, phone)' }, { status: 400 });
    }
    const id = newId('clinic');
    await env.DB.prepare(`
      INSERT INTO clinics (id, name, city, province, address, phone, lat, lng, image, verified, doctor_count, last_verified_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).bind(id, b.name, b.city, b.province, b.address, b.phone, num(b.lat), num(b.lng), b.image || null, b.verified ? 1 : 0, b.lastVerifiedDate || new Date().toISOString().slice(0, 10)).run();
    return json(await getClinicById(env.DB, id), { status: 201 });
  }

  if (pathname.startsWith('/api/clinics/')) {
    const id = pathname.split('/').filter(Boolean)[2];

    if (method === 'GET') {
      const clinic = await getClinicById(env.DB, id);
      if (!clinic) return json({ error: 'Clinic not found' }, { status: 404 });
      return json(clinic);
    }

    if (method === 'PUT' || method === 'PATCH') {
      if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
      const existing = await getClinicById(env.DB, id);
      if (!existing) return json({ error: 'Clinic not found' }, { status: 404 });
      const b = await request.json().catch(() => null);
      if (!b) return json({ error: 'Invalid body' }, { status: 400 });
      await env.DB.prepare(`
        UPDATE clinics SET name=?, city=?, province=?, address=?, phone=?, lat=?, lng=?, image=?, verified=?, last_verified_date=?
        WHERE id=?
      `).bind(
        b.name ?? existing.name, b.city ?? existing.city, b.province ?? existing.province,
        b.address ?? existing.address, b.phone ?? existing.phone,
        b.lat != null ? num(b.lat) : existing.lat, b.lng != null ? num(b.lng) : existing.lng,
        b.image ?? existing.image, (b.verified != null ? b.verified : existing.verified) ? 1 : 0,
        b.lastVerifiedDate ?? existing.lastVerifiedDate, id
      ).run();
      return json(await getClinicById(env.DB, id));
    }

    if (method === 'DELETE') {
      if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
      await env.DB.prepare(`DELETE FROM clinics WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }
  }

  // ---- Doctors ----
  if (pathname === '/api/doctors' && method === 'GET') {
    return json(await getDoctors(env.DB, {
      query: searchParams.get('query') || '',
      province: searchParams.get('province') || '',
      city: searchParams.get('city') || '',
      specialty: searchParams.get('specialty') || '',
    }));
  }

  if (pathname === '/api/doctors' && method === 'POST') {
    if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
    const b = await request.json().catch(() => null);
    if (!b?.name || !b?.primaryCity || !b?.primaryProvince || !b?.contact) {
      return json({ error: 'Missing required fields (name, primaryCity, primaryProvince, contact)' }, { status: 400 });
    }
    const id = newId('doc');
    await env.DB.prepare(`
      INSERT INTO doctors (id, name, specialty, primary_city, primary_province, contact, rating, review_count, verified, last_verified_date, sources_json)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, '[]')
    `).bind(id, b.name, b.specialty || 'Developmental Pediatrician', b.primaryCity, b.primaryProvince, b.contact, b.verified ? 1 : 0, b.lastVerifiedDate || new Date().toISOString().slice(0, 10)).run();

    if (b.clinicId) {
      await env.DB.prepare(`
        INSERT INTO doctor_clinics (id, doctor_id, clinic_id, schedule, is_primary) VALUES (?, ?, ?, ?, 1)
      `).bind(newId('dc'), id, b.clinicId, b.schedule || 'Schedule not yet listed').run();
    }
    return json(await getDoctorById(env.DB, id), { status: 201 });
  }

  if (pathname.startsWith('/api/doctors/') && pathname.endsWith('/reviews')) {
    const id = pathname.split('/').filter(Boolean)[2];
    return json(await getReviews(env.DB, id));
  }

  if (pathname.startsWith('/api/doctors/')) {
    const id = pathname.split('/').filter(Boolean)[2];

    if (method === 'GET') {
      const doctor = await getDoctorById(env.DB, id);
      if (!doctor) return json({ error: 'Doctor not found' }, { status: 404 });
      return json(doctor);
    }

    if (method === 'PUT' || method === 'PATCH') {
      if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
      const existing = await getDoctorById(env.DB, id);
      if (!existing) return json({ error: 'Doctor not found' }, { status: 404 });
      const b = await request.json().catch(() => null);
      if (!b) return json({ error: 'Invalid body' }, { status: 400 });
      await env.DB.prepare(`
        UPDATE doctors SET name=?, specialty=?, primary_city=?, primary_province=?, contact=?, verified=?, last_verified_date=?
        WHERE id=?
      `).bind(
        b.name ?? existing.name, b.specialty ?? existing.specialty,
        b.primaryCity ?? existing.primaryCity, b.primaryProvince ?? existing.primaryProvince,
        b.contact ?? existing.contact, (b.verified != null ? b.verified : existing.verified) ? 1 : 0,
        b.lastVerifiedDate ?? existing.lastVerifiedDate, id
      ).run();

      if (b.clinicId) {
        await env.DB.prepare(`DELETE FROM doctor_clinics WHERE doctor_id = ?`).bind(id).run();
        await env.DB.prepare(`
          INSERT INTO doctor_clinics (id, doctor_id, clinic_id, schedule, is_primary) VALUES (?, ?, ?, ?, 1)
        `).bind(newId('dc'), id, b.clinicId, b.schedule || 'Schedule not yet listed').run();
      }
      return json(await getDoctorById(env.DB, id));
    }

    if (method === 'DELETE') {
      if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
      await env.DB.prepare(`DELETE FROM doctors WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }
  }

  // ---- Public review/report submission ----
  if (pathname === '/api/reviews' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.doctorId || !body?.comment || !body?.rating) {
      return json({ error: 'Missing required fields' }, { status: 400 });
    }
    const id = newId('rev');
    await env.DB.prepare(`
      INSERT INTO reviews (id, doctor_id, author_name, rating, comment, status, submitted_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).bind(id, body.doctorId, body.authorName || 'Anonymous', Number(body.rating), body.comment, new Date().toISOString().slice(0, 10)).run();
    return json({ ok: true, id });
  }

  if (pathname === '/api/reports' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.doctorId || !body?.reason || !body?.details) {
      return json({ error: 'Missing required fields' }, { status: 400 });
    }
    const id = newId('rep');
    await env.DB.prepare(`
      INSERT INTO reports (id, doctor_id, reason, details, status, submitted_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).bind(id, body.doctorId, body.reason, body.details, new Date().toISOString().slice(0, 10)).run();
    return json({ ok: true, id });
  }

  // ---- Admin moderation ----
  if (pathname === '/api/admin/reviews' && method === 'GET') {
    if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
    const status = searchParams.get('status') || 'pending';
    const result = await env.DB.prepare(`
      SELECT r.id, r.doctor_id AS doctorId, d.name AS doctorName, r.author_name AS authorName,
             r.rating, r.comment, r.status, r.submitted_at AS submittedAt
      FROM reviews r JOIN doctors d ON d.id = r.doctor_id
      WHERE r.status = ?
      ORDER BY r.submitted_at DESC
    `).bind(status).all();
    return json(result.results);
  }

  if (pathname.match(/^\/api\/admin\/reviews\/[^/]+\/(approve|reject)$/) && method === 'POST') {
    if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
    const parts = pathname.split('/').filter(Boolean);
    const id = parts[3];
    const action = parts[4];
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await env.DB.prepare(`UPDATE reviews SET status=?, moderated_at=? WHERE id=?`)
      .bind(newStatus, new Date().toISOString().slice(0, 10), id).run();
    if (newStatus === 'approved') {
      const doctorRow = await env.DB.prepare(`SELECT doctor_id FROM reviews WHERE id = ?`).bind(id).first();
      if (doctorRow) {
        const agg = await env.DB.prepare(`
          SELECT COUNT(*) AS cnt, AVG(rating) AS avgRating FROM reviews WHERE doctor_id = ? AND status = 'approved'
        `).bind(doctorRow.doctor_id).first();
        await env.DB.prepare(`UPDATE doctors SET review_count=?, rating=? WHERE id=?`)
          .bind(Number(agg?.cnt || 0), Number(agg?.avgRating || 0), doctorRow.doctor_id).run();
      }
    }
    return json({ ok: true });
  }

  if (pathname === '/api/admin/reports' && method === 'GET') {
    if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
    const status = searchParams.get('status') || 'pending';
    const result = await env.DB.prepare(`
      SELECT rp.id, rp.doctor_id AS doctorId, d.name AS doctorName, rp.reason, rp.details,
             rp.status, rp.submitted_at AS submittedAt
      FROM reports rp JOIN doctors d ON d.id = rp.doctor_id
      WHERE rp.status = ?
      ORDER BY rp.submitted_at DESC
    `).bind(status).all();
    return json(result.results);
  }

  if (pathname.match(/^\/api\/admin\/reports\/[^/]+\/resolve$/) && method === 'POST') {
    if (!isAdminAuthed(request, env)) return json({ error: 'Unauthorized' }, { status: 401 });
    const id = pathname.split('/').filter(Boolean)[3];
    await env.DB.prepare(`UPDATE reports SET status='resolved', moderated_at=? WHERE id=?`)
      .bind(new Date().toISOString().slice(0, 10), id).run();
    return json({ ok: true });
  }

  return null; // not an /api/* route this Worker recognizes
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) return json({ error: 'D1 binding DB missing — check the [[d1_databases]] entry in wrangler.toml' }, { status: 500 });

      await ensureSchema(env.DB);

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);

      if (url.pathname.startsWith('/api/')) {
        const res = await handleApi(request, env, url);
        if (res) return res;
        return text('Not found', { status: 404 });
      }

      // Any non-/api/* request is the frontend app. If static assets are
      // bound (see wrangler.toml [assets]), serve the app from there;
      // otherwise this Worker is API-only and the frontend must be hosted
      // separately (e.g. Cloudflare Pages) with DEVPED_API_BASE_URL set to
      // this Worker's URL.
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ name: 'DevPed PH API', status: 'ok' });
    } catch (err) {
      return json({ error: err?.message || 'Internal error' }, { status: 500 });
    }
  },
};
