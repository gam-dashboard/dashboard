import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
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
    console.log(`Found ${files.length} JSON file(s) in ${dataDir}`);

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

      await client.query(
        `INSERT INTO projects (
           post_id, source_file, title, slug, status, description, tag_line, org_name, org_website,
           supporting_sites, video, video_2, post_date, project_start_date, search_text, row_fallback, imported_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, NULLIF($13, '')::timestamptz, $14, $15, $16::jsonb, NOW()
         )
         ON CONFLICT (post_id) DO UPDATE SET
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
          project.searchText || '',
          JSON.stringify(project.rowFallback || {}),
        ]
      );

      await client.query('DELETE FROM project_locations WHERE post_id = $1', [project.postId]);
      for (const [locationIndex, location] of project.locations.entries()) {
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
