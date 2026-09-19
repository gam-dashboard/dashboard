import fs from 'node:fs/promises';
import path from 'node:path';

const pickFirst = (...values) => values.find((value) => String(value || '').trim() !== '');

const parseCoordinate = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const toGeocodeCacheKey = (latitude, longitude) => {
  const lat = parseCoordinate(latitude);
  const lon = parseCoordinate(longitude);
  if (lat == null || lon == null) return '';
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
};

export const loadGeocodeCache = async (cachePath) => {
  try {
    const text = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
};

export const writeGeocodeCache = async (cachePath, cache) => {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
};

const normalizeNominatimAddress = (payload) => {
  const address = payload?.address && typeof payload.address === 'object' ? payload.address : {};
  const countryCodeRaw = pickFirst(address.country_code, address.countryCode);
  return {
    city: pickFirst(address.city, address.town, address.village, address.hamlet, address.municipality, address.county),
    state: pickFirst(address.state, address.region, address.state_district, address.province),
    country: pickFirst(address.country),
    country_code: String(countryCodeRaw || '').trim().toUpperCase(),
    display_name: pickFirst(payload?.display_name, payload?.name),
  };
};

export const reverseGeocodeWithCache = async ({
  latitude,
  longitude,
  cache,
  timeoutMs = 15000,
  userAgent = 'gam-dashboard-sync/1.0 (+https://github.com/gam-dashboard/dashboard)',
}) => {
  const cacheKey = toGeocodeCacheKey(latitude, longitude);
  if (!cacheKey) return { cacheKey: '', value: null, fromCache: false };

  const cached = cache?.[cacheKey];
  if (cached && typeof cached === 'object') {
    return { cacheKey, value: cached, fromCache: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lon', String(longitude));
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': userAgent,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Nominatim HTTP ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const value = normalizeNominatimAddress(payload);
    cache[cacheKey] = value;
    return { cacheKey, value, fromCache: false };
  } finally {
    clearTimeout(timeout);
  }
};
