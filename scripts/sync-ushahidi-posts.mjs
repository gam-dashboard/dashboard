import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { normalizeProjectPayload } from '../api/_lib/project-normalizer.js';
import {
  loadGeocodeCache,
  reverseGeocodeWithCache,
  toGeocodeCacheKey,
  writeGeocodeCache,
} from './geocode-cache.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const importerScriptPath = path.join(__dirname, 'import-json-to-postgres.mjs');

const args = process.argv.slice(2);
const getArgValue = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
};
const hasFlag = (flag) => args.includes(flag);

const dryRun = hasFlag('--dry-run');
const forceFull = hasFlag('--force-full');
const parsedPageSize = Number.parseInt(getArgValue('--page-size') || process.env.USHAHIDI_PAGE_SIZE || '50', 10);
const parsedMaxPages = Number.parseInt(getArgValue('--max-pages') || process.env.USHAHIDI_MAX_PAGES || '20', 10);
const pageSize = Number.isInteger(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : 50;
const maxPages = Number.isInteger(parsedMaxPages) && parsedMaxPages > 0 ? parsedMaxPages : 20;
const requestTimeoutMs = Number.parseInt(process.env.USHAHIDI_REQUEST_TIMEOUT_MS || '20000', 10);
const maxAttempts = Number.parseInt(process.env.USHAHIDI_REQUEST_ATTEMPTS || '3', 10);
const geocodeTimeoutMs = Number.parseInt(process.env.USHAHIDI_GEOCODE_TIMEOUT_MS || '15000', 10);
const geocodeUserAgent = String(
  process.env.USHAHIDI_GEOCODE_USER_AGENT || 'gam-dashboard-sync/1.0 (+https://github.com/gam-dashboard/dashboard)'
).trim();
const locationsDir = path.resolve(
  process.cwd(),
  getArgValue('--locations-dir') || process.env.PROJECT_LOCATIONS_CSV_DIR || 'src/data'
);
const geocodeCachePath = path.resolve(
  process.cwd(),
  getArgValue('--geocode-cache-path') || process.env.GEOCODE_CACHE_PATH || '.geocode_cache.json'
);

const apiBaseRaw = String(
  getArgValue('--api-base')
  || process.env.USHAHIDI_POSTS_API_URL
  || process.env.USHAHIDI_API_BASE
  || 'https://globalactionmosaic.api.ushahidi.io/api/v5/posts/'
).trim();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for periodic Ushahidi sync.');
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJsonWithRetry = async (url) => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = Math.min(5000, 500 * (2 ** (attempt - 1)));
        console.warn(`Fetch failed (${attempt}/${maxAttempts}) for ${url}: ${error instanceof Error ? error.message : error}`);
        await sleep(delay);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
};

const derivePostId = (post) => {
  const id = post?.id ?? post?.post_id ?? post?.postId ?? post?.result?.id ?? post?.result?.post_id ?? post?.result?.postId;
  return String(id ?? '').trim();
};

const ensureResultPayload = (post) => {
  if (post && typeof post === 'object' && post.result && typeof post.result === 'object') {
    return post;
  }
  const result = post && typeof post === 'object' ? { ...post } : { value: post };
  const postId = derivePostId(post);
  if (postId && result.id == null) result.id = postId;
  if (postId && result.post_id == null) result.post_id = postId;
  return { result };
};

const extractPosts = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.result && Array.isArray(payload.result)) return payload.result;
  if (payload.result && typeof payload.result === 'object' && Array.isArray(payload.result.results)) {
    return payload.result.results;
  }
  if (Array.isArray(payload.posts)) return payload.posts;
  return [];
};

const extractNextPageUrl = (payload, currentUrl, currentPage, fetchedCount) => {
  const directNext = payload?.next
    || payload?.next_page
    || payload?.nextPage
    || payload?.links?.next
    || payload?.pagination?.next;
  if (typeof directNext === 'string' && directNext.trim()) {
    return new URL(directNext, currentUrl).toString();
  }
  if (fetchedCount < pageSize) return null;
  const nextUrl = new URL(currentUrl);
  nextUrl.searchParams.set('page', String(currentPage + 1));
  return nextUrl.toString();
};

const buildInitialUrl = () => {
  const url = new URL(apiBaseRaw);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', String(pageSize));
  return url.toString();
};

const sanitizeFileId = (postId) => String(postId).replace(/[^a-zA-Z0-9._-]/g, '_');

const runImporter = (tempDir, importerLocationsDir) => new Promise((resolve, reject) => {
  const importerArgs = [importerScriptPath, '--dir', tempDir, '--locations-dir', importerLocationsDir || locationsDir];
  if (dryRun) importerArgs.push('--dry-run');
  const child = spawn(process.execPath, importerArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Importer exited with code ${code}`));
  });
});

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

const csvValue = (value) => {
  const text = String(value ?? '');
  if (!/["\n,]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
};

const writeLocationsCsv = async (rows, filePath) => {
  const header = 'post_id,lat,lon,city,state,country,country_code,display_name';
  const lines = rows.map((row) => [
    csvValue(row.post_id),
    csvValue(row.lat),
    csvValue(row.lon),
    csvValue(row.city),
    csvValue(row.state),
    csvValue(row.country),
    csvValue(row.country_code),
    csvValue(row.display_name),
  ].join(','));
  await fs.writeFile(filePath, `${[header, ...lines].join('\n')}\n`, 'utf8');
};

const buildSyncLocationMetadataRows = async (posts) => {
  const byCoordinate = new Map();
  const postCoordinatePairs = [];
  const seenPostCoordinates = new Set();

  for (const post of posts) {
    const normalized = normalizeProjectPayload(post.payload, { sourceFile: `${sanitizeFileId(post.postId)}.json` });
    for (const location of normalized.locations || []) {
      const cacheKey = toGeocodeCacheKey(location.latitude, location.longitude);
      if (!cacheKey) continue;
      const postCoordKey = `${post.postId}::${cacheKey}`;
      if (seenPostCoordinates.has(postCoordKey)) continue;
      seenPostCoordinates.add(postCoordKey);
      postCoordinatePairs.push({ postId: post.postId, cacheKey });
      if (!byCoordinate.has(cacheKey)) {
        byCoordinate.set(cacheKey, { latitude: location.latitude, longitude: location.longitude });
      }
    }
  }

  if (postCoordinatePairs.length === 0) {
    return { rows: [], uniqueCoordinates: 0, cacheHits: 0, cacheMisses: 0, cacheWrites: 0 };
  }

  const geocodeCache = await loadGeocodeCache(geocodeCachePath);
  const geocodedByKey = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const [cacheKey, coordinate] of byCoordinate.entries()) {
    try {
      const geocoded = await reverseGeocodeWithCache({
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        cache: geocodeCache,
        timeoutMs: geocodeTimeoutMs,
        userAgent: geocodeUserAgent,
      });
      if (!geocoded.value) continue;
      geocodedByKey.set(cacheKey, geocoded.value);
      if (geocoded.fromCache) {
        cacheHits += 1;
      } else {
        cacheMisses += 1;
        await sleep(1100);
      }
    } catch (error) {
      console.warn(`Reverse geocoding failed for ${cacheKey}:`, error instanceof Error ? error.message : error);
    }
  }

  if (!dryRun && cacheMisses > 0) {
    await writeGeocodeCache(geocodeCachePath, geocodeCache);
  }

  const rows = postCoordinatePairs.map(({ postId, cacheKey }) => {
    const metadata = geocodedByKey.get(cacheKey) || {};
    const [lat, lon] = cacheKey.split(',');
    return {
      post_id: postId,
      lat,
      lon,
      city: metadata.city || '',
      state: metadata.state || '',
      country: metadata.country || '',
      country_code: metadata.country_code || '',
      display_name: metadata.display_name || '',
    };
  });

  return { rows, uniqueCoordinates: byCoordinate.size, cacheHits, cacheMisses, cacheWrites: cacheMisses };
};

const stageLocationsDir = async (locationRows) => {
  const tempLocationsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ushahidi-location-metadata-'));
  const existingLocationFiles = await listLocationCsvFiles(locationsDir);
  for (const [index, filePath] of existingLocationFiles.entries()) {
    const destination = path.join(tempLocationsDir, `${index}-${path.basename(filePath)}`);
    await fs.copyFile(filePath, destination);
  }
  if (locationRows.length > 0) {
    await writeLocationsCsv(locationRows, path.join(tempLocationsDir, 'sync-discovered-locations.csv'));
  }
  return { tempLocationsDir, existingFilesCopied: existingLocationFiles.length };
};

const client = await pool.connect();

let transactionOpen = false;

try {
  await client.query('BEGIN');
  transactionOpen = true;
  await client.query(
    `CREATE TABLE IF NOT EXISTS project_sync_state (
      sync_key TEXT PRIMARY KEY,
      last_post_id TEXT,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`
  );

  const syncKey = 'ushahidi_posts';
  const stateRes = await client.query(
    'SELECT last_post_id FROM project_sync_state WHERE sync_key = $1',
    [syncKey]
  );
  const lastPostId = forceFull ? '' : String(stateRes.rows[0]?.last_post_id || '').trim();
  await client.query('COMMIT');
  transactionOpen = false;

  if (forceFull) {
    console.log('Running full sync (--force-full): existing cursor ignored.');
  } else {
    console.log(lastPostId ? `Resuming sync after post_id ${lastPostId}` : 'No previous sync cursor found; fetching newest pages.');
  }

  const seen = new Set();
  const newPosts = [];
  let url = buildInitialUrl();
  let page = 1;
  let reachedCursor = false;

  while (url && page <= maxPages && !reachedCursor) {
    console.log(`Fetching page ${page}: ${url}`);
    const payload = await fetchJsonWithRetry(url);
    const posts = extractPosts(payload);
    if (posts.length === 0) break;

    for (const post of posts) {
      const postId = derivePostId(post);
      if (!postId) continue;
      if (!forceFull && lastPostId) {
        const numericPostId = Number(postId);
        const numericCursor = Number(lastPostId);
        if (Number.isFinite(numericPostId) && Number.isFinite(numericCursor) && numericPostId <= numericCursor) {
          reachedCursor = true;
          break;
        }
      }
      if (seen.has(postId)) continue;
      seen.add(postId);
      newPosts.push({ postId, payload: ensureResultPayload(post) });
    }

    if (!reachedCursor) {
      url = extractNextPageUrl(payload, url, page, posts.length);
      page += 1;
    }
  }

  if (newPosts.length === 0) {
    console.log('No new posts found.');
    if (!dryRun) {
      await client.query(
        `INSERT INTO project_sync_state (sync_key, last_post_id, last_synced_at, metadata)
         VALUES ($1, $2, NOW(), $3::jsonb)
         ON CONFLICT (sync_key) DO UPDATE SET
           last_synced_at = NOW(),
           metadata = project_sync_state.metadata || EXCLUDED.metadata`,
        [syncKey, lastPostId || null, JSON.stringify({ fetched_pages: page - 1, new_posts: 0 })]
      );
    }
  } else {
    const newestPostId = newPosts[0].postId;
    const importOrder = [...newPosts].reverse();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ushahidi-post-sync-'));
    const locationMetadata = await buildSyncLocationMetadataRows(importOrder);
    const { tempLocationsDir, existingFilesCopied } = await stageLocationsDir(locationMetadata.rows);

    try {
      for (const post of importOrder) {
        const filePath = path.join(tempDir, `${sanitizeFileId(post.postId)}.json`);
        await fs.writeFile(filePath, `${JSON.stringify(post.payload, null, 2)}\n`, 'utf8');
      }
      console.log(
        `Prepared ${locationMetadata.rows.length} location metadata row(s) for ${locationMetadata.uniqueCoordinates} unique coordinate(s); `
        + `cache hits: ${locationMetadata.cacheHits}, misses: ${locationMetadata.cacheMisses}`
      );
      console.log(
        `Staged location metadata in ${tempLocationsDir} (copied ${existingFilesCopied} existing locations CSV file(s))`
      );
      console.log(`Prepared ${importOrder.length} post payload(s) in ${tempDir}`);
      await runImporter(tempDir, tempLocationsDir);
    } finally {
      await fs.rm(tempLocationsDir, { recursive: true, force: true });
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    if (!dryRun) {
      await client.query(
        `INSERT INTO project_sync_state (sync_key, last_post_id, last_synced_at, metadata)
         VALUES ($1, $2, NOW(), $3::jsonb)
         ON CONFLICT (sync_key) DO UPDATE SET
           last_post_id = EXCLUDED.last_post_id,
           last_synced_at = NOW(),
           metadata = project_sync_state.metadata || EXCLUDED.metadata`,
        [syncKey, newestPostId, JSON.stringify({ fetched_pages: page - 1, new_posts: newPosts.length })]
      );
    }

    console.log(`${dryRun ? 'Dry-run sync parsed' : 'Sync imported'} ${newPosts.length} new post(s).`);
  }
} catch (error) {
  if (transactionOpen) {
    await client.query('ROLLBACK');
  }
  console.error('Ushahidi sync failed:', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
