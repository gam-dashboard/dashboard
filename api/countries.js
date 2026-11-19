import { isDatabaseConfigured, isSchemaMissingError } from './_lib/db.js';
import { listCountries } from './_lib/project-store.js';

const fallbackResponse = (message) => ({
  ok: true,
  configured: false,
  source: 'stub',
  message,
  countries: [],
  total: 0,
});

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  if (!isDatabaseConfigured()) {
    return res.status(200).json(
      fallbackResponse('DATABASE_URL is not configured yet. Countries are available once Postgres is ready.')
    );
  }

  try {
    const countries = await listCountries();

    return res.status(200).json({
      ok: true,
      configured: true,
      source: 'postgres',
      countries,
      total: countries.length,
    });
  } catch (error) {
    console.warn('api/countries fallback:', error);
    const message = isSchemaMissingError(error)
      ? 'Postgres is configured but the project schema has not been imported yet.'
      : (error instanceof Error ? error.message : 'Database unavailable');
    return res.status(200).json(fallbackResponse(message));
  }
}
