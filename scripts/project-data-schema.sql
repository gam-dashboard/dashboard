CREATE TABLE IF NOT EXISTS projects (
  post_id TEXT PRIMARY KEY,
  form_id INTEGER,
  source_file TEXT,
  title TEXT NOT NULL DEFAULT '',
  slug TEXT,
  status TEXT,
  description TEXT,
  tag_line TEXT,
  org_name TEXT,
  org_website TEXT,
  supporting_sites TEXT,
  video TEXT,
  video_2 TEXT,
  post_date TIMESTAMPTZ,
  project_start_date TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  row_fallback JSONB NOT NULL DEFAULT '{}'::jsonb,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS form_id INTEGER;

CREATE TABLE IF NOT EXISTS project_locations (
  post_id TEXT NOT NULL REFERENCES projects(post_id) ON DELETE CASCADE,
  location_index INTEGER NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  city TEXT,
  state TEXT,
  country TEXT,
  country_code TEXT,
  display_name TEXT,
  raw_location JSONB NOT NULL DEFAULT '{}'::jsonb,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, location_index)
);

CREATE TABLE IF NOT EXISTS project_taxonomy (
  post_id TEXT NOT NULL REFERENCES projects(post_id) ON DELETE CASCADE,
  taxonomy_type TEXT NOT NULL,
  value TEXT NOT NULL,
  raw_value JSONB,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, taxonomy_type, value)
);

ALTER TABLE project_taxonomy DROP CONSTRAINT IF EXISTS project_taxonomy_taxonomy_type_check;

CREATE TABLE IF NOT EXISTS project_raw_payloads (
  post_id TEXT PRIMARY KEY REFERENCES projects(post_id) ON DELETE CASCADE,
  source_file TEXT,
  payload JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_locations_post_id ON project_locations (post_id);
CREATE INDEX IF NOT EXISTS idx_project_locations_country ON project_locations (country);
CREATE INDEX IF NOT EXISTS idx_project_locations_city ON project_locations (city);
CREATE INDEX IF NOT EXISTS idx_project_taxonomy_post_id ON project_taxonomy (post_id);
CREATE INDEX IF NOT EXISTS idx_project_taxonomy_type_value ON project_taxonomy (taxonomy_type, value);

CREATE TABLE IF NOT EXISTS project_sync_state (
  sync_key TEXT PRIMARY KEY,
  last_post_id TEXT,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
