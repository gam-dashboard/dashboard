Dashboard (Vite + React + TypeScript + Vega-Lite)

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Build

```bash
npm run build
npm run preview
```

## Postgres migration scaffold

This repository still works with the existing CSV files by default. The new database path is opt-in and intended as a migration scaffold while Render/Postgres is being set up.

### What was added

- `scripts/project-data-schema.sql` defines normalized Postgres tables for projects, locations, taxonomy values, and raw JSON payload storage.
- `scripts/import-json-to-postgres.mjs` reads per-post JSON files, normalizes them, and upserts by `post_id`.
- `api/projects.js` and `api/locations.js` expose database-backed endpoints with safe stub responses when Postgres is not configured yet.
- `src/utils/projectApi.ts` provides a frontend compatibility helper, and `MapView` can use it when `VITE_USE_DB_API=true`.

### Environment variables

Copy `.env.local.example` to `.env.local` and fill in the values you need:

- `DATABASE_URL`: Render Postgres connection string.
- `PGSSLMODE=require`: recommended for Render-hosted Postgres.
- `PROJECT_JSON_DATA_DIR`: absolute or repo-relative directory containing `{post_id}.json` files.
- `VITE_USE_DB_API=false`: keep `false` until the API and DB are ready.
- `VITE_API_BASE_URL`: optional separate API origin for Render deployments.

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
```

The importer is safe to re-run:

- `projects` are upserted by `post_id`
- locations and taxonomy rows are replaced for the same `post_id`
- the original raw JSON is preserved in `project_raw_payloads`

### API usage

When the API is deployed with `DATABASE_URL` configured:

- `GET /api/projects`
- `GET /api/projects?postId=793`
- `GET /api/locations`
- `GET /api/locations?country=Kenya&city=Nairobi`

If the database is not configured yet, these endpoints return an empty, non-breaking stub payload so the frontend can fall back to CSV data.

### Frontend compatibility mode

To try the database-backed source without removing the CSV fallback:

```bash
VITE_USE_DB_API=true
```

With that flag enabled, `MapView` first tries `/api/projects`. If the API is unavailable or returns the migration stub, it automatically falls back to the existing CSV loading path.

## Deployment notes

The current static site deployment still works unchanged. If you deploy the API on Render or another serverless host, point `VITE_API_BASE_URL` at that service and keep the same fallback behavior during the migration.

The Vite base is set to `/dashboard/` so the site will work as a project site at:

`https://<username>.github.io/dashboard/`

If you change the repository name or publish as a user site, update `vite.config.ts`.
