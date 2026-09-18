import { Pool } from 'pg';

let pool;

const requiresSsl = () => {
  const mode = String(process.env.PGSSLMODE || '').toLowerCase();
  if (['require', 'verify-ca', 'verify-full'].includes(mode)) return true;
  return /render\.com|dpg-/i.test(String(process.env.DATABASE_URL || ''));
};

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL is not configured');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: requiresSsl() ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
}

export function isSchemaMissingError(error) {
  return Boolean(error && typeof error === 'object' && error.code === '42P01');
}
