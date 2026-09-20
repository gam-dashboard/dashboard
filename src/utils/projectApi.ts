export type ApiProjectLocation = {
  id: string;
  postId: string;
  position: [number, number];
  city?: string;
  state?: string;
  country?: string;
  country_code?: string;
  display_name?: string;
};

export type ApiProject = {
  postId: string;
  formId?: number;
  title: string;
  description: string;
  tagLine: string;
  org: string;
  goals: string[];
  categories: string[];
  searchText: string;
  postDate: Date | null;
  row: Record<string, string>;
  locations: ApiProjectLocation[];
  orgWebsite?: string;
  supportingSites?: string;
  video?: string;
  video2?: string;
  projectStartDate?: string;
  tags?: string[];
  seekingResources?: string[];
  providingResources?: string[];
  rawPayload?: unknown;
};

const getApiBaseUrl = () => String(import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export const isProjectApiEnabled = () => String(import.meta.env.VITE_USE_DB_API || '').toLowerCase() === 'true';

const normalizeLocation = (location: any): ApiProjectLocation | null => {
  if (!location || !Array.isArray(location.position) || location.position.length !== 2) return null;
  const longitude = Number(location.position[0]);
  const latitude = Number(location.position[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;

  return {
    id: String(location.id || `${location.postId || 'project'}::0`),
    postId: String(location.postId || ''),
    position: [longitude, latitude],
    city: location.city || undefined,
    state: location.state || undefined,
    country: location.country || undefined,
    country_code: location.country_code || undefined,
    display_name: location.display_name || undefined,
  };
};

const normalizeOptionalFormId = (value: unknown): number | undefined => {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return undefined;
  return parsed;
};

const normalizeProject = (project: any): ApiProject => ({
  postId: String(project.postId || ''),
  formId: normalizeOptionalFormId(project.formId),
  title: String(project.title || project.org || project.postId || ''),
  description: String(project.description || ''),
  tagLine: String(project.tagLine || ''),
  org: String(project.org || ''),
  goals: Array.isArray(project.goals) ? project.goals.map((value: unknown) => String(value)) : [],
  categories: Array.isArray(project.categories) ? project.categories.map((value: unknown) => String(value)) : [],
  searchText: String(project.searchText || '').toLowerCase(),
  postDate: project.postDate ? new Date(project.postDate) : null,
  row: project.row && typeof project.row === 'object' && !Array.isArray(project.row)
    ? Object.fromEntries(Object.entries(project.row).map(([key, value]) => [key, value == null ? '' : String(value)]))
    : {},
  locations: Array.isArray(project.locations)
    ? project.locations.map(normalizeLocation).filter(Boolean) as ApiProjectLocation[]
    : [],
  orgWebsite: project.orgWebsite ? String(project.orgWebsite) : undefined,
  supportingSites: project.supportingSites ? String(project.supportingSites) : undefined,
  video: project.video ? String(project.video) : undefined,
  video2: project.video2 ? String(project.video2) : undefined,
  projectStartDate: project.projectStartDate ? String(project.projectStartDate) : undefined,
  tags: Array.isArray(project.tags) ? project.tags.map((value: unknown) => String(value)) : [],
  seekingResources: Array.isArray(project.seekingResources) ? project.seekingResources.map((value: unknown) => String(value)) : [],
  providingResources: Array.isArray(project.providingResources) ? project.providingResources.map((value: unknown) => String(value)) : [],
  rawPayload: project.rawPayload,
});

export async function fetchCompatibleProjectsFromApi(): Promise<ApiProject[] | null> {
  if (!isProjectApiEnabled()) return null;

  const response = await fetch(`${getApiBaseUrl()}/api/projects`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) return null;

  const payload = await response.json();
  if (!payload?.configured) return null;
  if (!Array.isArray(payload.projects)) return [];
  return payload.projects.map(normalizeProject);
}

export async function fetchCompatibleLocationsFromApi(): Promise<ApiProjectLocation[] | null> {
  if (!isProjectApiEnabled()) return null;

  const response = await fetch(`${getApiBaseUrl()}/api/locations`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) return null;

  const payload = await response.json();
  if (!payload?.configured) return null;
  if (!Array.isArray(payload.locations)) return [];
  return payload.locations.map(normalizeLocation).filter(Boolean) as ApiProjectLocation[];
}
