import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import Papa from 'papaparse';
import { normalizeProjectPayload } from '../api/_lib/project-normalizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, 'project-data-schema.sql');

const args = process.argv.slice(2);
const getArgValue = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
};

const hasFlag = (flag) => args.includes(flag);

const dataDir = path.resolve(
  process.cwd(),
  getArgValue('--dir') || process.env.PROJECT_JSON_DATA_DIR || 'data/json'
);
const locationsDir = path.resolve(
  process.cwd(),
  getArgValue('--locations-dir') || process.env.PROJECT_LOCATIONS_CSV_DIR || 'src/data'
);
const dryRun = hasFlag('--dry-run');
const schemaOnly = hasFlag('--schema-only');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to import JSON into Postgres.');
  process.exit(1);
}

const requiresSsl = () => {
  const mode = String(process.env.PGSSLMODE || '').toLowerCase();
  if (['require', 'verify-ca', 'verify-full'].includes(mode)) return true;
  return /render\.com|dpg-/i.test(String(process.env.DATABASE_URL || ''));
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: requiresSsl() ? { rejectUnauthorized: false } : undefined,
});

const listJsonFiles = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJsonFiles(resolved);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) return [resolved];
    return [];
  }));
  return files.flat().sort();
};

const parseNumber = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const listLocationCsvFiles = async (directory) => {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return listLocationCsvFiles(resolved);
    if (entry.isFile() && /locations\.csv$/i.test(entry.name)) return [resolved];
    return [];
  }));
  return files.flat().sort();
};

const loadLocationMetadata = async (directory) => {
  const files = await listLocationCsvFiles(directory);
  const byPostId = new Map();
  let rowsLoaded = 0;

  for (const filePath of files) {
    const sourceFile = path.relative(process.cwd(), filePath);
    const csvText = await fs.readFile(filePath, 'utf8');
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    if (parsed.errors?.length) {
      console.warn(`Location CSV parse warnings in ${sourceFile}:`, parsed.errors.map((e) => e.message).join('; '));
    }
    for (const row of parsed.data || []) {
      const postId = String(row?.post_id || row?.postId || row?.['Post ID'] || '').trim();
      if (!postId) continue;
      const metadata = {
        latitude: parseNumber(row?.lat ?? row?.latitude),
        longitude: parseNumber(row?.lon ?? row?.lng ?? row?.longitude),
        city: String(row?.city || '').trim(),
        state: String(row?.state || '').trim(),
        country: String(row?.country || '').trim(),
        country_code: String(row?.country_code || row?.countryCode || '').trim(),
        display_name: String(row?.display_name || row?.displayName || '').trim(),
        source_file: sourceFile,
      };
      const bucket = byPostId.get(postId) || [];
      bucket.push(metadata);
      byPostId.set(postId, bucket);
      rowsLoaded += 1;
    }
  }

  return { byPostId, filesLoaded: files.length, rowsLoaded };
};

const locationDistance = (a, b) => {
  if (a?.latitude == null || a?.longitude == null || b?.latitude == null || b?.longitude == null) return Infinity;
  return Math.hypot(a.latitude - b.latitude, a.longitude - b.longitude);
};

const enrichLocationsWithCsvMetadata = (project, metadataByPostId) => {
  const metadataRows = metadataByPostId.get(project.postId) || [];
  if (metadataRows.length === 0) return project.locations;

  const enriched = project.locations.map((location) => ({ ...location }));
  const usedIndices = new Set();

  const pickLocationIndex = (metadata) => {
    if (enriched.length === 0) return -1;
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < enriched.length; index += 1) {
      if (usedIndices.has(index)) continue;
      const distance = locationDistance(enriched[index], metadata);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex !== -1) return bestIndex;
    for (let index = 0; index < enriched.length; index += 1) {
      const distance = locationDistance(enriched[index], metadata);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex === -1 ? 0 : bestIndex;
  };

  for (const metadata of metadataRows) {
    let targetIndex = pickLocationIndex(metadata);

    if (targetIndex === -1 && metadata.latitude != null && metadata.longitude != null) {
      enriched.push({
        latitude: metadata.latitude,
        longitude: metadata.longitude,
        city: metadata.city || '',
        state: metadata.state || '',
        country: metadata.country || '',
        country_code: metadata.country_code || '',
        display_name: metadata.display_name || '',
        raw_location: { source: 'locations.csv', source_file: metadata.source_file },
      });
      continue;
    }

    if (targetIndex === -1) continue;
    usedIndices.add(targetIndex);
    const target = enriched[targetIndex];
    if (metadata.latitude != null) target.latitude = metadata.latitude;
    if (metadata.longitude != null) target.longitude = metadata.longitude;
    if (metadata.city) target.city = metadata.city;
    if (metadata.state) target.state = metadata.state;
    if (metadata.country) target.country = metadata.country;
    if (metadata.country_code) target.country_code = metadata.country_code;
    if (metadata.display_name) target.display_name = metadata.display_name;
    target.raw_location = {
      ...(target.raw_location && typeof target.raw_location === 'object' ? target.raw_location : {}),
      csv_metadata: {
        source_file: metadata.source_file,
        city: metadata.city || null,
        state: metadata.state || null,
        country: metadata.country || null,
        country_code: metadata.country_code || null,
        display_name: metadata.display_name || null,
      },
    };
  }

  return enriched;
};

const schemaSql = await fs.readFile(schemaPath, 'utf8');
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(schemaSql);

  if (schemaOnly) {
    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('Schema validated in dry-run mode.');
    } else {
      await client.query('COMMIT');
      console.log('Schema ensured successfully.');
    }
  } else {
    const files = await listJsonFiles(dataDir);
    const locationMetadata = await loadLocationMetadata(locationsDir);
    console.log(`Found ${files.length} JSON file(s) in ${dataDir}`);
    console.log(
      `Loaded ${locationMetadata.rowsLoaded} location metadata row(s) from ${locationMetadata.filesLoaded} CSV file(s) in ${locationsDir}`
    );

    let imported = 0;
    let skipped = 0;

    for (const filePath of files) {
      const sourceFile = path.relative(process.cwd(), filePath);
      let payload;
      try {
        payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch (error) {
        skipped += 1;
        console.warn(`Skipping unreadable JSON: ${sourceFile}`, error instanceof Error ? error.message : error);
        continue;
      }

      const project = normalizeProjectPayload(payload, { sourceFile });
      if (!project.postId) {
        skipped += 1;
        console.warn(`Skipping ${sourceFile}: no post_id could be derived`);
        continue;
      }

      console.log(`Importing post ${project.postId} from ${sourceFile}`);
      imported += 1;

      if (dryRun) continue;

      const mergedLocations = enrichLocationsWithCsvMetadata(project, locationMetadata.byPostId);

      const locationSearchText = mergedLocations
        .flatMap((location) => [
          location.city,
          location.state,
          location.country,
          location.country_code,
          location.display_name,
        ])
        .filter(Boolean)
        .join(' ');
      
      const searchableText = [
        project.searchText,
        locationSearchText,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      await client.query(
        `INSERT INTO projects (
          post_id, form_id, source_file, title, slug, status, description, tag_line, org_name, org_website,
           supporting_sites, video, video_2, post_date, project_start_date, search_text, row_fallback, imported_at
         ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, NULLIF($14, '')::timestamptz, $15, $16, $17::jsonb, NOW()
         )
         ON CONFLICT (post_id) DO UPDATE SET
           form_id = EXCLUDED.form_id,
           source_file = EXCLUDED.source_file,
           title = EXCLUDED.title,
           slug = EXCLUDED.slug,
           status = EXCLUDED.status,
           description = EXCLUDED.description,
           tag_line = EXCLUDED.tag_line,
           org_name = EXCLUDED.org_name,
           org_website = EXCLUDED.org_website,
           supporting_sites = EXCLUDED.supporting_sites,
           video = EXCLUDED.video,
           video_2 = EXCLUDED.video_2,
           post_date = EXCLUDED.post_date,
           project_start_date = EXCLUDED.project_start_date,
           search_text = EXCLUDED.search_text,
           row_fallback = EXCLUDED.row_fallback,
           imported_at = NOW()`,
        [
          project.postId,
          project.formId ?? null,
          project.sourceFile,
          project.title,
          project.slug || null,
          project.status || null,
          project.description || null,
          project.tagLine || null,
          project.orgName || null,
          project.orgWebsite || null,
          project.supportingSites || null,
          project.video || null,
          project.video2 || null,
          project.postDate || null,
          project.projectStartDate || null,
          searchableText,
          JSON.stringify(project.rowFallback || {}),
        ]
      );

      await client.query('DELETE FROM project_locations WHERE post_id = $1', [project.postId]);
      for (const [locationIndex, location] of mergedLocations.entries()) {
        await client.query(
          `INSERT INTO project_locations (
             post_id, location_index, latitude, longitude, city, state, country, country_code, display_name, raw_location, imported_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW()
           )`,
          [
            project.postId,
            locationIndex,
            location.latitude,
            location.longitude,
            location.city || null,
            location.state || null,
            location.country || null,
            location.country_code || null,
            location.display_name || null,
            JSON.stringify(location.raw_location || {}),
          ]
        );
      }

      await client.query('DELETE FROM project_taxonomy WHERE post_id = $1', [project.postId]);
      for (const taxonomy of project.taxonomies) {
        await client.query(
          `INSERT INTO project_taxonomy (post_id, taxonomy_type, value, raw_value, imported_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())`,
          [project.postId, taxonomy.taxonomy_type, taxonomy.value, JSON.stringify(taxonomy.raw_value)]
        );
      }

      await client.query(
        `INSERT INTO project_raw_payloads (post_id, source_file, payload, imported_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (post_id) DO UPDATE SET
           source_file = EXCLUDED.source_file,
           payload = EXCLUDED.payload,
           imported_at = NOW()`,
        [project.postId, project.sourceFile, JSON.stringify(project.rawPayload)]
      );
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log(`Dry run complete. Parsed ${imported} project(s), skipped ${skipped}.`);
    } else {
      await client.query('COMMIT');
      console.log(`Import complete. Imported ${imported} project(s), skipped ${skipped}.`);
    }
  }
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Import failed:', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
