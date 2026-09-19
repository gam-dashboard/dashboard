import { isDatabaseConfigured, isSchemaMissingError } from './_lib/db.js';
import { listProjects } from './_lib/project-store.js';

const fallbackResponse = (message) => ({
  ok: true,
  configured: false,
  source: 'stub',
  message,
  projects: [],
  total: 0,
});

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  if (!isDatabaseConfigured()) {
    return res.status(200).json(
      fallbackResponse('DATABASE_URL is not configured yet. Continue using the CSV frontend fallback until Postgres is ready.')
    );
  }

  try {
    const includeRaw = String(req.query?.includeRaw || '').toLowerCase() === 'true';
    const projects = await listProjects({
      postIds: req.query?.postId,
      formIds: req.query?.formId,
      includeRaw,
      limit: req.query?.limit,
    });

    return res.status(200).json({
      ok: true,
      configured: true,
      source: 'postgres',
      projects,
      total: projects.length,
    });
  } catch (error) {
    console.warn('api/projects fallback:', error);
    const message = isSchemaMissingError(error)
      ? 'Postgres is configured but the project schema has not been imported yet.'
      : (error instanceof Error ? error.message : 'Database unavailable');
    return res.status(200).json(fallbackResponse(message));
  }
}
