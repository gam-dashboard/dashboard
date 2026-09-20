const MAX_HISTORY_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 1200;
const MAX_QUESTION_LENGTH = 600;
const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_CONTEXT_PROJECTS = 1000;
export const MAX_RELEVANT_PROJECTS = 20;

export const CHAT_ROUTE_CONFIGS = {
  global: {
    routeKey: 'global',
    title: 'Global Projects Intelligence',
    description: 'Global Action Mosaic projects visible on the main dashboard.',
    allowedFormIds: [3, 5],
  },
  wa: {
    routeKey: 'wa',
    title: 'WA State Health Data Assistant',
    description: 'Washington dashboard scope. No database-backed form visibility is currently configured for this route.',
    allowedFormIds: [],
  },
  syria: {
    routeKey: 'syria',
    title: 'Syria Projects Intelligence',
    description: 'Projects for Syria dashboard scope.',
    allowedFormIds: [7],
  },
};

const ROUTE_ALIASES = {
  '#/': 'global',
  '#/watracker': 'wa',
  '#/syprojects': 'syria',
  global: 'global',
  wa: 'wa',
  washington: 'wa',
  syria: 'syria',
};

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'among', 'been', 'being', 'between', 'could', 'from', 'have', 'into',
  'just', 'like', 'make', 'more', 'most', 'only', 'over', 'than', 'that', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
  'show', 'give', 'tell', 'help', 'need', 'want', 'project', 'projects', 'dashboard', 'data', 'route', 'scope',
]);

const toArray = (value) => Array.isArray(value) ? value : [];

const incrementCount = (map, key) => {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  map.set(normalizedKey, (map.get(normalizedKey) || 0) + 1);
};

const takeTopCounts = (map, limit = 8) => Array.from(map.entries())
  .sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  })
  .slice(0, limit)
  .map(([label, count]) => ({ label, count }));

const formatProjectForSearch = (project) => {
  const locationText = toArray(project.locations)
    .flatMap((location) => [location.city, location.state, location.country, location.display_name])
    .filter(Boolean)
    .join(' ');

  return [
    project.postId,
    project.title,
    project.description,
    project.tagLine,
    project.org,
    project.searchText,
    ...toArray(project.goals),
    ...toArray(project.categories),
    ...toArray(project.tags),
    ...toArray(project.seekingResources),
    ...toArray(project.providingResources),
    locationText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
};

const mapProjectForChat = (project) => ({
  postId: project.postId,
  title: project.title,
  org: project.org,
  postDate: project.postDate,
  goals: toArray(project.goals).slice(0, 5),
  categories: toArray(project.categories).slice(0, 5),
  tags: toArray(project.tags).slice(0, 5),
  locationNames: toArray(project.locations)
    .map((location) => location.display_name || location.city || location.state || location.country)
    .filter(Boolean)
    .slice(0, 3),
  description: String(project.description || '').trim().slice(0, MAX_DESCRIPTION_LENGTH),
  orgWebsite: project.orgWebsite || '',
  supportingSites: project.supportingSites || '',
  video: project.video || '',
  video2: project.video2 || '',
  status: project.status || '',
  slug: project.slug || '',
  projectStartDate: project.projectStartDate || '',
});

export const normalizeRouteKey = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ROUTE_ALIASES[normalized] || null;
};

export const getChatRouteConfig = (value) => {
  const routeKey = normalizeRouteKey(value);
  return routeKey ? CHAT_ROUTE_CONFIGS[routeKey] || null : null;
};

export const sanitizeChatMessages = (value) => toArray(value)
  .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
  .map((entry) => ({
    role: entry.role,
    content: String(entry.content || '').trim().slice(0, MAX_MESSAGE_LENGTH),
  }))
  .filter((entry) => entry.content.length > 0)
  .slice(-MAX_HISTORY_MESSAGES);

export const sanitizeQuestion = (value) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUESTION_LENGTH);

export const getProjectQueryOptions = (routeConfig) => ({
  formIds: Array.isArray(routeConfig?.allowedFormIds) ? routeConfig.allowedFormIds : undefined,
  limit: MAX_CONTEXT_PROJECTS,
});

export const summarizeProjectsForChat = (projects) => {
  const countries = new Map();
  const goals = new Map();
  const categories = new Map();
  const tags = new Map();
  let withLocations = 0;
  let withWebsites = 0;
  let withDescriptions = 0;

  projects.forEach((project) => {
    if (toArray(project.locations).length > 0) withLocations += 1;
    if (String(project.orgWebsite || '').trim()) withWebsites += 1;
    if (String(project.description || '').trim()) withDescriptions += 1;

    const seenCountries = new Set();
    toArray(project.locations).forEach((location) => {
      const country = String(location.country || '').trim();
      if (!country || seenCountries.has(country)) return;
      seenCountries.add(country);
      incrementCount(countries, country);
    });

    toArray(project.goals).forEach((value) => incrementCount(goals, value));
    toArray(project.categories).forEach((value) => incrementCount(categories, value));
    toArray(project.tags).forEach((value) => incrementCount(tags, value));
  });

  const recentProjects = [...projects]
    .filter((project) => project.postDate)
    .sort((a, b) => String(b.postDate).localeCompare(String(a.postDate)))
    .slice(0, 5)
    .map((project) => ({
      postId: project.postId,
      title: project.title,
      org: project.org,
      postDate: project.postDate,
    }));

  return {
    totalProjects: projects.length,
    withLocations,
    withWebsites,
    withDescriptions,
    topCountries: takeTopCounts(countries),
    topGoals: takeTopCounts(goals),
    topCategories: takeTopCounts(categories),
    topTags: takeTopCounts(tags),
    recentProjects,
  };
};

export const selectRelevantProjects = (projects, question) => {
  const normalizedQuestion = String(question || '').toLowerCase();
  const searchTerms = Array.from(new Set(
    normalizedQuestion
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
  )).slice(0, 12);

  const scored = projects
    .map((project) => {
      const haystack = formatProjectForSearch(project);
      let score = 0;
      searchTerms.forEach((term) => {
        if (haystack.includes(term)) score += 1;
      });
      if (score === 0 && searchTerms.length > 0) return null;
      return { project, score };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.project.postDate || '').localeCompare(String(a.project.postDate || ''));
    })
    .slice(0, MAX_RELEVANT_PROJECTS)
    .map(({ project }) => mapProjectForChat(project));

  if (scored.length > 0) return scored;

  return projects.slice(0, MAX_RELEVANT_PROJECTS).map((project) => mapProjectForChat(project));
};

export const buildChatContext = ({ routeConfig, projects, question }) => ({
  route: {
    routeKey: routeConfig.routeKey,
    title: routeConfig.title,
    description: routeConfig.description,
    allowedFormIds: routeConfig.allowedFormIds,
  },
  summary: summarizeProjectsForChat(projects),
  relevantProjects: selectRelevantProjects(projects, question),
});

export const buildSystemPrompt = (context) => `You are a concise data insights assistant for the ${context.route.title} dashboard.

Use only the structured route context that follows. Never claim access to records or metrics that are not present in the provided context. If the question cannot be answered from the available data, say that clearly and suggest a narrower follow-up question.

Rules:
- Keep answers grounded in the provided counts and project records.
- Mention route scope when it matters.
- Prefer aggregate insights first, then cite example projects when helpful.
- If a provided project field is empty, you may say that no value is listed in the available dashboard data for that field.
- When formatting helps, use Markdown for short paragraphs, lists, bold emphasis, inline code, and fenced code blocks. Do not use raw HTML.
- Do not invent SQL, hidden filters, or unseen fields.
- If the user asks for data outside the visible route scope, explain that the assistant is restricted to that dashboard's records.
`;

export const buildUserPrompt = ({ question, context }) => `Question: ${question}

Route context JSON:
${JSON.stringify(context, null, 2)}`;
