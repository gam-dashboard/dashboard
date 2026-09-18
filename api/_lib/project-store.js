import { getPool } from './db.js';

const toArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];

const parsePostIds = (value) => {
  const ids = toArray(value)
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
};

const parseLimit = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 5000);
};

const normalizeRowFallback = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, entry == null ? '' : String(entry)])
  );
};

const mapLocationRow = (row) => ({
  id: `${row.post_id}::${row.location_index}`,
  postId: row.post_id,
  position: [Number(row.longitude), Number(row.latitude)],
  city: row.city || undefined,
  state: row.state || undefined,
  country: row.country || undefined,
  country_code: row.country_code || undefined,
  display_name: row.display_name || undefined,
});

export async function listProjects(options = {}) {
  const pool = getPool();
  const postIds = parsePostIds(options.postIds);
  const includeRaw = options.includeRaw === true;
  const limit = parseLimit(options.limit, 500);

  const params = [];
  let whereClause = '';
  if (postIds.length > 0) {
    params.push(postIds);
    whereClause = `WHERE post_id = ANY($${params.length}::text[])`;
  }
  params.push(limit);

  const projectsResult = await pool.query(
    `SELECT post_id, source_file, title, slug, status, description, tag_line, org_name, org_website,
            supporting_sites, video, video_2, post_date, project_start_date, search_text, row_fallback
       FROM projects
       ${whereClause}
       ORDER BY post_date DESC NULLS LAST, post_id ASC
       LIMIT $${params.length}`,
    params
  );

  if (projectsResult.rows.length === 0) return [];

  const foundPostIds = projectsResult.rows.map((row) => row.post_id);
  const [locationsResult, taxonomyResult, rawPayloadResult] = await Promise.all([
    pool.query(
      `SELECT post_id, location_index, latitude, longitude, city, state, country, country_code, display_name
         FROM project_locations
        WHERE post_id = ANY($1::text[])
        ORDER BY post_id ASC, location_index ASC`,
      [foundPostIds]
    ),
    pool.query(
      `SELECT post_id, taxonomy_type, value
         FROM project_taxonomy
        WHERE post_id = ANY($1::text[])
        ORDER BY post_id ASC, taxonomy_type ASC, value ASC`,
      [foundPostIds]
    ),
    includeRaw
      ? pool.query(
          `SELECT post_id, payload
             FROM project_raw_payloads
            WHERE post_id = ANY($1::text[])`,
          [foundPostIds]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const locationsByPostId = new Map();
  for (const row of locationsResult.rows) {
    const bucket = locationsByPostId.get(row.post_id) || [];
    bucket.push(mapLocationRow(row));
    locationsByPostId.set(row.post_id, bucket);
  }

  const taxonomyByPostId = new Map();
  for (const row of taxonomyResult.rows) {
    const bucket = taxonomyByPostId.get(row.post_id) || { goal: [], category: [], tag: [] };
    bucket[row.taxonomy_type]?.push(row.value);
    taxonomyByPostId.set(row.post_id, bucket);
  }

  const rawByPostId = new Map(rawPayloadResult.rows.map((row) => [row.post_id, row.payload]));

  return projectsResult.rows.map((row) => {
    const taxonomy = taxonomyByPostId.get(row.post_id) || { goal: [], category: [], tag: [] };
    const locations = locationsByPostId.get(row.post_id) || [];
    return {
      postId: row.post_id,
      title: row.title || row.org_name || row.post_id,
      description: row.description || '',
      tagLine: row.tag_line || '',
      org: row.org_name || '',
      goals: taxonomy.goal,
      categories: taxonomy.category,
      tags: taxonomy.tag,
      searchText: row.search_text || '',
      postDate: row.post_date ? new Date(row.post_date).toISOString() : null,
      row: normalizeRowFallback(row.row_fallback),
      locations,
      orgWebsite: row.org_website || '',
      supportingSites: row.supporting_sites || '',
      video: row.video || '',
      video2: row.video_2 || '',
      projectStartDate: row.project_start_date || '',
      sourceFile: row.source_file || '',
      slug: row.slug || '',
      status: row.status || '',
      ...(includeRaw ? { rawPayload: rawByPostId.get(row.post_id) || null } : {}),
    };
  });
}

export async function listLocations(options = {}) {
  const pool = getPool();
  const postIds = parsePostIds(options.postIds);
  const limit = parseLimit(options.limit, 1000);
  const conditions = [];
  const params = [];

  const addTextFilter = (column, value) => {
    if (value == null || String(value).trim() === '') return;
    params.push(`%${String(value).trim()}%`);
    conditions.push(`${column} ILIKE $${params.length}`);
  };

  if (postIds.length > 0) {
    params.push(postIds);
    conditions.push(`post_id = ANY($${params.length}::text[])`);
  }

  addTextFilter('city', options.city);
  addTextFilter('state', options.state);
  addTextFilter('country', options.country);

  params.push(limit);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT post_id, location_index, latitude, longitude, city, state, country, country_code, display_name
       FROM project_locations
       ${whereClause}
       ORDER BY post_id ASC, location_index ASC
       LIMIT $${params.length}`,
    params
  );

  return result.rows.map(mapLocationRow);
}
