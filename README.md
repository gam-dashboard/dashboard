Dashboard (Vite + React + TypeScript + Vega-Lite)

## Local development

```bash
npm install

# terminal 1: frontend
npm run dev

# terminal 2: Express API for /api/projects, /api/locations, and /api/chat
npm run api
```

Open http://localhost:5173

For local frontend/API split development, set:

```bash
VITE_API_BASE_URL=http://localhost:10000
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

## Build

```bash
npm run build
npm run preview
```

## Postgres migration scaffold

This repository still works with the existing CSV files by default. The new database path is opt-in and intended as a migration scaffold while Render/Postgres is being set up.

### What was added

- `scripts/project-data-schema.sql` defines normalized Postgres tables for projects, locations, flexible taxonomy values, raw JSON payload storage, and periodic sync cursor state.
- `scripts/import-json-to-postgres.mjs` reads per-post JSON files, normalizes them, and upserts by `post_id`.
- `api/projects.js` and `api/locations.js` expose database-backed endpoints with safe stub responses when Postgres is not configured yet.
- `src/utils/projectApi.ts` provides a frontend compatibility helper, and `MapView` can use it when `VITE_USE_DB_API=true`.

### Environment variables

Copy `.env.local.example` to `.env.local` and fill in the values you need:

- `DATABASE_URL`: Render Postgres connection string.
- `PGSSLMODE=require`: recommended for Render-hosted Postgres.
- `OPENAI_API_KEY`: required server-side secret for `/api/chat`. Never expose it as a `VITE_` variable.
- `OPENAI_MODEL`: optional chatbot model override (defaults to `gpt-4o-mini`).
- `OPENAI_BASE_URL`: optional OpenAI-compatible provider/proxy base URL.
- `CORS_ALLOWED_ORIGINS`: optional comma-separated origins allowed to call the Express API (useful when the frontend and API run on different hosts locally or in deployment).
- `PROJECT_JSON_DATA_DIR`: absolute or repo-relative directory containing `{post_id}.json` files.
- `PROJECT_LOCATIONS_CSV_DIR`: optional directory containing `*locations.csv` files used to enrich city/state/country/display_name metadata.
- `USHAHIDI_POSTS_API_URL`: optional override for the Ushahidi posts endpoint used by periodic sync (defaults to `https://globalactionmosaic.api.ushahidi.io/api/v5/posts/`).
- `USHAHIDI_PAGE_SIZE`: optional page size for periodic sync (default `50`).
- `USHAHIDI_MAX_PAGES`: optional max pages fetched per run (default `20`).
- `GEOCODE_CACHE_PATH`: optional path to reverse-geocode cache JSON used during sync (defaults to repo-root `.geocode_cache.json`).
- `VITE_USE_DB_API=false`: keep `false` until the API and DB are ready.
- `VITE_API_BASE_URL`: optional separate API origin for Render deployments or local Express development.

### Importing JSON into Postgres

Run the importer after `DATABASE_URL` and `PROJECT_JSON_DATA_DIR` are set:

```bash
npm run import:projects -- --dir /absolute/path/to/json/files
```

Useful options:

```bash
# create/verify schema only
npm run import:projects -- --schema-only

# parse files without committing rows
npm run import:projects -- --dry-run --dir /absolute/path/to/json/files

# override CSV metadata directory used to enrich project_locations
npm run import:projects -- --dir /absolute/path/to/json/files --locations-dir /absolute/path/to/location-csv-dir
```

The importer is safe to re-run:

- `projects` are upserted by `post_id`
- locations and taxonomy rows are replaced for the same `post_id`
- the original raw JSON is preserved in `project_raw_payloads`
- title/description are imported from canonical `result.title` and `result.content` when present
- `result.form_id` is imported into `projects.form_id`
- taxonomy values are imported with flexible `taxonomy_type` (e.g. `goal`, `category`, `tag`, `seeking_resources`, `providing_resources`)
- location metadata (city/state/country/display_name) is enriched from repository `*locations.csv` rows matched by `post_id` and coordinate proximity

### Periodic sync for new Ushahidi posts

Use the periodic sync script to fetch newly created posts from the Ushahidi API, stage them as JSON payloads, and reuse the existing DB importer/upsert flow:

```bash
npm run sync:ushahidi
```

Useful options:

```bash
# parse and stage new posts, but do not commit DB rows
npm run sync:ushahidi -- --dry-run

# ignore stored cursor and backfill newest pages
npm run sync:ushahidi -- --force-full

# override page controls for one run
npm run sync:ushahidi -- --page-size 100 --max-pages 40

# override reverse-geocode cache path for one run
npm run sync:ushahidi -- --geocode-cache-path /absolute/path/to/.geocode_cache.json
```

The sync cursor is persisted in `project_sync_state` (`sync_key='ushahidi_posts'`) so periodic runs only import posts newer than the most recently synced `post_id`.
Newly discovered posts are also reverse-geocoded during sync and staged into importer-compatible `post_id,lat,lon,city,state,country,country_code,display_name` rows so `project_locations` gets enriched metadata on import. Reverse-geocode lookups use the shared `.geocode_cache.json` key format (`"lat.toFixed(5),lon.toFixed(5)"`) and should point at the repository-root cache file (or a configured `GEOCODE_CACHE_PATH`) to preserve cache hits across runs.

### Render Cron Job (primary scheduler)

`render.yaml` defines the supported scheduler for periodic Ushahidi sync:

- service type: Render Cron Job (`ushahidi-post-sync`)
- command: `npm run sync:ushahidi`
- schedule: every 3 minutes (`*/3 * * * *`)

Required environment variables in Render:

- `DATABASE_URL` (secret; do not commit it). The Blueprint keeps this as `sync: false`, so set it in the Render dashboard when creating/importing the service.
- `PGSSLMODE=require`
- `USHAHIDI_POSTS_API_URL` (defaults to `https://globalactionmosaic.api.ushahidi.io/api/v5/posts/`)

Deployment/import steps:

1. In Render, choose **New +** → **Blueprint** and select this repository.
2. Confirm the `ushahidi-post-sync` Cron Job from `render.yaml` is detected.
3. Set `DATABASE_URL` in the Render dashboard (Environment) to your existing Render Postgres connection string.
   - If your existing database is outside this Blueprint, keep this as a manual secret value; do not attempt to commit credentials.
4. Ensure `PGSSLMODE` is set to `require`.
5. Deploy the Blueprint and verify the Cron Job runs on the every-3-minutes schedule.

Operational notes:

- `project_sync_state` persists the cursor (`last_post_id`), so reruns continue from the last successful sync.
- The sync script includes retry logic for transient API failures and is designed to be idempotent with importer upserts.
- Avoid overlapping duplicate schedulers (for example, do not run a second periodic GitHub Actions cron for the same job).

If your database was created before `form_id` support was added, re-run either:

```bash
npm run import:projects -- --schema-only
```

or a full import command so the `projects.form_id` column is added (if missing) and populated.

### API usage

When the API is deployed with `DATABASE_URL` configured:

- `GET /api/projects`
- `GET /api/projects?postId=793`
- `GET /api/projects?formId=3,5`
- `GET /api/locations`
- `GET /api/locations?country=Kenya&city=Nairobi`
- `POST /api/chat` with `{ routeKey, question, messages? }` to query a route-scoped, DB-backed chatbot context server-side

If the database is not configured yet, these endpoints return an empty, non-breaking stub payload so the frontend can fall back to CSV data.

`/api/chat` does not expose raw SQL or entire tables to the model. It scopes requests to known dashboard routes (`global`, `syria`, `wa`), loads a bounded project set from Postgres, computes safe aggregates/top values, selects a small set of relevant project snippets, and then calls the configured server-side LLM provider. If a route has no DB-backed records yet (currently the WA dashboard scope), the endpoint returns a clear empty-data response instead of falling back to CSVs.

### Frontend compatibility mode

To try the database-backed source without removing the CSV fallback:

```bash
VITE_USE_DB_API=true
```

With that flag enabled, `MapView` first tries `/api/projects`. If the API is unavailable or returns the migration stub, it automatically falls back to the existing CSV loading path.

## Deployment notes

The current static site deployment still works for the map/dashboard UI, but the re-enabled chatbot now requires a live API host for `/api/chat`. If you deploy the frontend to GitHub Pages, also deploy the Express/serverless API (for example on Render or Vercel) and point `VITE_API_BASE_URL` at that service.

The Vite base is set to `/dashboard/` so the site will work as a project site at:

`https://<username>.github.io/dashboard/`

If you change the repository name or publish as a user site, update `vite.config.ts`.
