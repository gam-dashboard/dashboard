const GOAL_PATTERN = /(Goal\s*\d+\s*:\s*[^;|]+?)(?=Goal\s*\d+|$)/gi;

const normalizeKey = (value) => String(value || '')
  .replace(/\u00A0/g, ' ')
  .replace(/^\uFEFF/, '')
  .trim()
  .replace(/^"+|"+$/g, '')
  .replace(/\s+/g, ' ')
  .toLowerCase();

const parseNum = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

const parseNullableInteger = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const toIsoTimestamp = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const utcWithT = new Date(text.replace(' ', 'T') + 'Z');
  if (!Number.isNaN(utcWithT.getTime())) return utcWithT.toISOString();
  return '';
};

const uniqueStrings = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};

const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];

const firstDefined = (...values) => values.find((value) => value != null && String(value).trim() !== '');

const isScalarValue = (value) => ['string', 'number', 'boolean'].includes(typeof value);

const textFromValue = (value) => {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => textFromValue(item));
  }
  if (typeof value === 'object') {
    return [
      ...textFromValue(firstDefined(
        value.value,
        value.label,
        value.name,
        value.title,
        value.text,
        value.tag,
        value.url,
        value.description
      )),
    ];
  }
  return [];
};

const SDG_PARENT_LABEL = 'sustainable development goals (sdgs)';

  const normalizeGoal = (value) => String(value || '')
      .replace(/\s+sustainable development goals\s*\(sdgs\)\s*$/i, '')
      .trim()
      .replace(/[,;|]+$/, '');

  const parseGoalValues = (value) => {
    const rawText = textFromValue(value).join(' ');
    if (!rawText.trim()) return [];
    
    const matches = Array.from(
      rawText.matchAll(
        /(Goal\s*\d+\s*:\s*.*?)(?=\s+Goal\s*\d+\s*:|\s+Sustainable Development Goals\s*\(SDGs\)|$)/gi
      )
    )
    .map((match) => normalizeGoal(match[1]))
    .filter((goal) => /^goal\s*\d+\s*:/i.test(goal));

    if (matches.length > 0) return uniqueStrings(matches);

    return uniqueStrings(
      rawText
        .split(/[\n|;,]+/)
        .map(normalizeGoal)
        .filter((item) => /^goal\s*\d+\s*:/i.test(item))
    );
  };

const parseTaxonomyValues = (value) => uniqueStrings(
  textFromValue(value)
    .flatMap((entry) => String(entry).split(/[\n|;,]+/))
    .map((entry) => entry.trim())
    .filter(Boolean)
);

const splitKnownTaxonomyScalar = (value) => uniqueStrings(
  String(value || '')
    .split(/[\n|;,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
);

const parseSelectedTaxonomyValues = (value, { splitScalars = true } = {}) => {
  if (value == null) return [];
  if (isScalarValue(value)) {
    const text = String(value).trim();
    if (!text) return [];
    return splitScalars ? splitKnownTaxonomyScalar(text) : [text];
  }
  if (Array.isArray(value)) {
    return uniqueStrings(
      value.flatMap((item) => parseSelectedTaxonomyValues(item, { splitScalars: false }))
    );
  }
  if (typeof value === 'object') {
    const directValue = firstDefined(
      value.tag,
      value.label,
      value.name,
      value.title,
      value.text,
      isScalarValue(value.value) ? value.value : null
    );
    if (directValue != null) {
      const text = String(directValue).trim();
      return text ? [text] : [];
    }
    if (value.value !== undefined) {
      return parseSelectedTaxonomyValues(value.value, { splitScalars });
    }
  }
  return [];
};

const normalizeTaxonomyType = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

const taxonomyEntriesFromLookup = (lookup, taxonomyType, candidates, parser = parseTaxonomyValues) => {
  const entries = [];
  const seen = new Set();
  const values = pickLookupValues(lookup, candidates);
  for (const raw of values) {
    for (const parsed of parser(raw)) {
      const text = String(parsed || '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ taxonomy_type: taxonomyType, value: text, raw_value: raw });
    }
  }
  return entries;
};

const buildLookup = (payload) => {
  const lookup = new Map();
  const seen = new WeakSet();

  const add = (key, value) => {
    const normalized = normalizeKey(key);
    if (!normalized || value == null) return;
    const bucket = lookup.get(normalized) || [];
    bucket.push(value);
    lookup.set(normalized, bucket);
  };

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const fieldKey = firstDefined(node.key, node.label, node.name, node.slug, node.field_key, node.field_label, node.identifier);
    const fieldValue = firstDefined(node.value, node.values, node.answer, node.answers, node.response, node.responses, node.data);
    if (fieldKey && fieldValue !== undefined) {
      add(fieldKey, fieldValue);
      if (node.label && node.label !== fieldKey) add(node.label, fieldValue);
      if (node.name && node.name !== fieldKey) add(node.name, fieldValue);
    }

    for (const [key, value] of Object.entries(node)) {
      add(key, value);
      visit(value);
    }
  };

  visit(payload);
  return lookup;
};

const pickLookupValue = (lookup, candidates) => {
  for (const candidate of candidates) {
    const values = lookup.get(normalizeKey(candidate)) || [];
    for (const value of values) {
      const text = textFromValue(value).find((entry) => String(entry).trim() !== '');
      if (text) return String(text).trim();
    }
  }
  return '';
};

const pickLookupValues = (lookup, candidates) => {
  const values = [];
  for (const candidate of candidates) {
    values.push(...(lookup.get(normalizeKey(candidate)) || []));
  }
  return values;
};

const TAXONOMY_FIELD_ALIASES = new Map([
  ['goal', ['sustainable development goals', 'sustainable development goal', 'sdg', 'sdgs']],
  ['category', ['categories', 'category']],
  ['tag', ['tags', 'tag']],
  ['seeking_resources', ['seeking resources']],
  ['providing_resources', ['providing resources']],
]);

const taxonomyTypeFromField = (...labels) => {
  for (const label of labels) {
    const normalized = normalizeKey(label);
    if (!normalized) continue;
    for (const [taxonomyType, aliases] of TAXONOMY_FIELD_ALIASES.entries()) {
      if (aliases.includes(normalized)) return taxonomyType;
    }
  }
  return '';
};

const isSdgDefinitionValue = (value) => {
  const labels = value && typeof value === 'object'
    ? [
        value.parent,
        value.group,
        value.group_label,
        value.category,
        value.category_label,
        value.field,
        value.field_label,
        value.label,
      ]
    : [value];

  return labels.some((label) => normalizeKey(label).includes(SDG_PARENT_LABEL));
};

const collectSelectedTaxonomies = (payload, result) => {
  const entries = [];
  const seen = new Set();
  const authoritativeTypes = new Set();

  const addEntry = (taxonomyType, value, rawValue) => {
    const text = String(value || '').trim();
    if (!taxonomyType || !text) return;
    const key = `${taxonomyType}::${text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      taxonomy_type: taxonomyType,
      value: text,
      raw_value: rawValue,
    });
  };

  const addParsedEntries = (taxonomyType, rawValue, values) => {
    values.forEach((value) => addEntry(taxonomyType, value, rawValue));
  };

  const resultCategories = Array.isArray(result?.categories) ? result.categories : [];
  if (resultCategories.length > 0) {
    for (const selectedCategory of resultCategories) {
      const goalValues = parseGoalValues(selectedCategory);
      if (goalValues.length > 0) {
        addParsedEntries('goal', { source: 'result.categories', submitted_value: selectedCategory }, goalValues);
        authoritativeTypes.add('goal');
        continue;
      }

      const categoryValues = parseSelectedTaxonomyValues(selectedCategory, { splitScalars: false });
      if (
        categoryValues.length === 0
        || isSdgDefinitionValue(selectedCategory)
        || categoryValues.some((value) => normalizeKey(value) === 'propose your own goal')
      ) {
        continue;
      }

      addParsedEntries(
        'category',
        { source: 'result.categories', submitted_value: selectedCategory },
        categoryValues
      );
      authoritativeTypes.add('category');
    }
  }

  const skipKeys = new Set(['options', 'children', 'description']);
  const seenNodes = new WeakSet();

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seenNodes.has(node)) return;
    seenNodes.add(node);

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const fieldValue = firstDefined(node.value, node.values, node.answer, node.answers, node.response, node.responses, node.data);
    if (fieldValue !== undefined) {
      const taxonomyType = taxonomyTypeFromField(
        node.key,
        node.label,
        node.name,
        node.slug,
        node.field_key,
        node.field_label,
        node.identifier
      );

      if (
        taxonomyType
        && !(
          ['goal', 'category'].includes(taxonomyType)
          && authoritativeTypes.has(taxonomyType)
        )
      ) {
        const values = taxonomyType === 'goal'
          ? parseGoalValues(fieldValue)
          : parseSelectedTaxonomyValues(fieldValue);
        addParsedEntries(
          taxonomyType,
          {
            source: 'field.value',
            field_label: firstDefined(node.label, node.field_label, node.key, node.name, node.identifier) || '',
            submitted_value: fieldValue,
          },
          values
        );
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (skipKeys.has(normalizeKey(key))) continue;
      visit(value);
    }
  };

  visit(payload);
  return entries;
};

const collectLocations = (payload) => {
  const seen = new WeakSet();
  const locations = [];

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const latitude = parseNum(firstDefined(node.lat, node.latitude, node.y));
    const longitude = parseNum(firstDefined(node.lon, node.lng, node.longitude, node.x));
    if (latitude != null && longitude != null) {
      locations.push({
        latitude,
        longitude,
        city: firstDefined(node.city, node.locality, node.town) || '',
        state: firstDefined(node.state, node.region, node.province) || '',
        country: firstDefined(node.country, node.country_name) || '',
        country_code: firstDefined(node.country_code, node.countryCode) || '',
        display_name: firstDefined(node.display_name, node.name, node.label, node.address) || '',
        raw_location: node,
      });
    }

    for (const value of Object.values(node)) visit(value);
  };

  visit(payload);

  const deduped = [];
  const keys = new Set();
  for (const location of locations) {
    const key = [
      location.latitude,
      location.longitude,
      String(location.city || '').toLowerCase(),
      String(location.country || '').toLowerCase(),
    ].join('::');
    if (keys.has(key)) continue;
    keys.add(key);
    deduped.push(location);
  }
  return deduped;
};

export function normalizeProjectPayload(payload, options = {}) {
  const lookup = buildLookup(payload);
  const result = payload && typeof payload === 'object' && payload.result && typeof payload.result === 'object'
    ? payload.result
    : null;
  const formId = parseNullableInteger(result?.form_id);
  const sourceFile = options.sourceFile || '';
  const postId = pickLookupValue(lookup, ['post id', 'postid', 'id']) || sourceFile.replace(/\.json$/i, '').split('/').pop() || '';
  const title = firstDefined(result?.title, pickLookupValue(lookup, ['project', 'project name', 'title', 'project title', 'name'])) || postId;
  const description = firstDefined(result?.content, pickLookupValue(lookup, ['description', 'unstructured description', 'summary', 'abstract', 'content'])) || '';
  const tagLine = pickLookupValue(lookup, ['project tag line', 'tagline', 'tag line']);
  const orgName = pickLookupValue(lookup, ['organization name', 'organization', 'partner']);
  const orgWebsite = pickLookupValue(lookup, ['organization website', 'organization url', 'website', 'website url']);
  const supportingSites = pickLookupValue(lookup, ['supporting sites', 'supporting site']);
  const video = pickLookupValue(lookup, ['video', 'video url', 'video link']);
  const video2 = pickLookupValue(lookup, ['video 2', 'video2', 'video 2 url']);
  const projectStartDate = pickLookupValue(lookup, ['project start date', 'start date']);
  const slug = pickLookupValue(lookup, ['slug']);
  const status = pickLookupValue(lookup, ['status']);
  const postDate = toIsoTimestamp(
    pickLookupValue(lookup, ['post date (utc)', 'post date', 'created (utc)', 'created', 'date'])
  );
  const taxonomies = collectSelectedTaxonomies(payload, result);
  const goalsTaxonomy = taxonomies.filter((entry) => entry.taxonomy_type === 'goal');
  const categoriesTaxonomy = taxonomies.filter((entry) => entry.taxonomy_type === 'category');
  const tagsTaxonomy = taxonomies.filter((entry) => entry.taxonomy_type === 'tag');
  const goals = goalsTaxonomy.map((entry) => entry.value);
  const categories = categoriesTaxonomy.map((entry) => entry.value);
  const tags = tagsTaxonomy.map((entry) => entry.value);
  const locations = collectLocations(payload);
  const countries = uniqueStrings(locations.map((location) => location.country).filter(Boolean));
  const rowFallback = {
    'Post ID': postId,
    Title: title,
    Organization: orgName,
    Country: countries.join(', '),
    source_file: sourceFile,
  };
  const searchText = [
    postId,
    title,
    description,
    tagLine,
    orgName,
    orgWebsite,
    supportingSites,
    video,
    video2,
    projectStartDate,
    ...goals,
    ...categories,
    ...tags,
    ...countries,
  ].filter(Boolean).join(' ').toLowerCase();

  return {
    postId,
    formId,
    sourceFile,
    title,
    slug,
    status,
    description,
    tagLine,
    orgName,
    orgWebsite,
    supportingSites,
    video,
    video2,
    postDate,
    projectStartDate,
    searchText,
    rowFallback,
    locations,
    taxonomies,
    rawPayload: payload,
  };
}
