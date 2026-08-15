import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import Papa from 'papaparse';
import sampleCsvUrl from '../data/sample.csv?url';
import locationsCsvUrl from '../data/locations.csv?url';
import React, { useEffect, useRef, useState, useMemo } from 'react';

type CsvRow = Record<string, string>;
type Point = {
  id: string;
  position: [number, number];
  row: CsvRow;
  sourceField?: string;
  postId?: string;
  title?: string;
  description?: string;
  tagLine?: string;
  org?: string;
  goals?: string[];
  searchText?: string;
  city?: string;
  state?: string;
  country?: string;
  country_code?: string;
  display_name?: string;
  allLocations?: Point[];
};

// Public worker path (you copied the file into public/)
const WORKER_PUBLIC_PATH = '/maplibre-gl-worker.mjs';

export default function MapView(): JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const [points, setPoints] = useState<Point[]>([]);
  const [selected, setSelected] = useState<Point | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; text: string } | null>(null);

  // filter UI state
  const [uniqueGoals, setUniqueGoals] = useState<string[]>([]);
  const [activeGoals, setActiveGoals] = useState<string[]>([]);
  const [filterMinimized, setFilterMinimized] = useState<boolean>(true); // start minimized

  // search queries
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');

  // city enrichment / UI
  const [uniqueCities, setUniqueCities] = useState<string[]>([]);
  const [activeCity, setActiveCity] = useState<string | null>(null);

  // Defensive attempt to set maplibre worker URL
  try {
    (maplibregl as any).workerUrl = WORKER_PUBLIC_PATH;
  } catch {
    try {
      Object.defineProperty(maplibregl as any, 'workerUrl', {
        value: WORKER_PUBLIC_PATH,
        configurable: true,
        enumerable: false,
        writable: false
      });
    } catch {
      try {
        (globalThis as any).__MAPLIBRE_WORKER_URL = WORKER_PUBLIC_PATH;
      } catch {
        console.warn('Could not set maplibre worker url; worker may load from default path');
      }
    }
  }

  // Utility: numeric-aware goal sort (extract first number and use that; fall back to lexicographic)
  const goalSort = (a: string, b: string) => {
    const num = (s: string) => {
      const m = String(s).match(/(\d{1,2})/);
      return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
    };
    const na = num(a), nb = num(b);
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  };

  // Haversine for matching nearest loc row for a post with multiple locations
  const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const coordKey = (lat: number, lon: number, prec = 5) => `${lat.toFixed(prec)},${lon.toFixed(prec)}`;

  // Parse CSV into points (same logic as before)
  useEffect(() => {
    Papa.parse<CsvRow>(sampleCsvUrl, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data as CsvRow[];

        const headers = results.meta.fields || (rows.length ? Object.keys(rows[0]) : []);
        const normalize = (s: string) =>
          String(s || '')
            .replace(/\u00A0/g, ' ')
            .replace(/^\uFEFF/, '')
            .trim()
            .replace(/^"+|"+$/g, '')
            .replace(/\s+/g, ' ')
            .replace(/\s*\(\d+\)$/, '')
            .replace(/_\d+$/, '')
            .toLowerCase();

        const normalizedHeaders = headers.map((h) => ({ orig: h, norm: normalize(h) }));

        const findLonForLat = (latOrig: string, row: CsvRow) => {
          const directCandidates = [
            latOrig.replace(/(lat|latitude)/i, 'lon'),
            latOrig.replace(/(lat|latitude)/i, 'lng'),
            latOrig.replace(/(lat|latitude)/i, 'longitude')
          ];
          for (const cand of directCandidates) {
            if (Object.prototype.hasOwnProperty.call(row, cand)) return cand;
          }

          const latNorm = normalize(latOrig);
          const candidates = [
            latNorm.replace(/(?:lat|latitude)$/, 'lon'),
            latNorm.replace(/(?:lat|latitude)$/, 'lng'),
            latNorm.replace(/(?:lat|latitude)$/, 'longitude')
          ];

          for (const c of candidates) {
            const matches = normalizedHeaders.filter((h) => h.norm === c);
            if (matches.length === 0) continue;

            const suffRe = /(\(\d+\)|_\d+)$/;
            const latSuf = (latOrig.match(suffRe) || [])[0];
            const suffixMatch = matches.find((m) => latSuf && m.orig.endsWith(latSuf));
            if (suffixMatch && Object.prototype.hasOwnProperty.call(row, suffixMatch.orig)) return suffixMatch.orig;

            const firstMatch = matches.find((m) => Object.prototype.hasOwnProperty.call(row, m.orig));
            if (firstMatch) return firstMatch.orig;
          }

          const prefix = latNorm.replace(/(?:lat|latitude)$/, '').trim();
          if (prefix) {
            const lonMatch = normalizedHeaders.find((h) => h.norm.startsWith(prefix) && (h.norm.includes('lon') || h.norm.includes('lng') || h.norm.includes('longitude')));
            if (lonMatch) return lonMatch.orig;
          }

          const anyLon = normalizedHeaders.find((h) => h.norm.includes('lon') || h.norm.includes('lng') || h.norm.includes('longitude'));
          return anyLon ? anyLon.orig : undefined;
        };

        const pickPreferred = (row: CsvRow, candidateBases: string[], preferredSuffix?: string) => {
          const keys = Object.keys(row);
          const findWithSuffix = (candidateBase: string) => {
            if (preferredSuffix) {
              const k = keys.find((orig) => {
                const norm = normalize(orig);
                return norm === candidateBase.toLowerCase() && orig.endsWith(preferredSuffix) && String(row[orig]).trim() !== '';
              });
              if (k) return row[k];
            }
            const k2 = keys.find((orig) => {
              const norm = normalize(orig);
              return norm === candidateBase.toLowerCase() && String(row[orig]).trim() !== '';
            });
            if (k2) return row[k2];
            return undefined;
          };

          for (const candidate of candidateBases) {
            if (Object.prototype.hasOwnProperty.call(row, candidate) && String(row[candidate]).trim() !== '') {
              return row[candidate];
            }
            const val = findWithSuffix(candidate);
            if (val !== undefined) return val;
          }
          return undefined;
        };

        // parse SDG strings into array
        const parseGoals = (raw: string | undefined): string[] => {
          if (!raw) return [];
          const s = String(raw).replace(/\r?\n/g, ' ').trim();
          if (!s) return [];
          const longMatches = Array.from(s.matchAll(/(Goal\s*\d+\s*:\s*[^,;]+)/gi)).map(m => m[1].trim());
          if (longMatches.length) return Array.from(new Set(longMatches.map(mm => mm)));
          const shortMatches = Array.from(s.matchAll(/(Goal\s*\d+)/gi)).map(m => m[1].trim());
          if (shortMatches.length) return Array.from(new Set(shortMatches.map(sm => sm)));
          const parts = s.split(/[,;|]+/).map(p => p.trim()).filter(Boolean);
          return Array.from(new Set(parts));
        };

        const extracted: Point[] = [];
        const missingRows: Array<{ idx: number; postId?: string; row: CsvRow }> = [];
        const numericFailures: Array<{ idx: number; postId?: string; latKey: string; latVal: string; lonKey?: string; lonVal?: string }> = [];
        const multiPointRows: Array<{ idx: number; postId?: string; count: number; sources: string[] }> = [];

        // find SDG-like header candidates once
        const sdgHeaderEntries = normalizedHeaders.filter(h => h.norm.includes('sustainable development goal') || h.norm.includes('sustainable development goals') || h.norm.includes('sdg'));

        rows.forEach((r, rowIndex) => {
          const foundSources: string[] = [];

          for (const h of headers) {
            if (!h) continue;
            const hNorm = normalize(h);
            if (!hNorm.includes('lat') && !hNorm.includes('latitude')) continue;
            const lonKey = findLonForLat(h, r);
            if (!lonKey) continue;
            const latRaw = r[h];
            const lonRaw = r[lonKey];
            if (latRaw == null || lonRaw == null || String(latRaw).trim() === '' || String(lonRaw).trim() === '') continue;

            const latNum = parseFloat(String(latRaw).replace(',', '.').trim());
            const lonNum = parseFloat(String(lonRaw).replace(',', '.').trim());

            if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
              numericFailures.push({ idx: rowIndex, postId: r['Post ID'], latKey: h, latVal: String(latRaw), lonKey, lonVal: String(lonRaw) });
              continue;
            }

            const suffRe = /(\(\d+\)|_\d+)$/;
            const latSuffix = (h.match(suffRe) || [])[0];

            const postIdVal = pickPreferred(r, ['post id', 'postid'], latSuffix) ?? (r['Post ID'] || r['post id'] || r['PostID']);
            const titleVal = pickPreferred(r, ['project', 'project name'], latSuffix) ?? '';
            const descVal = pickPreferred(r, ['description', 'unstructured description'], latSuffix) ?? '';
            const tagLineVal = pickPreferred(r, ['project tag line'], latSuffix) ?? '';
            const orgVal = pickPreferred(r, ['organization name', 'organization'], latSuffix) ?? '';

            // collect goals from all SDG-like columns for this row
            let goals: string[] = [];
            for (const sh of sdgHeaderEntries) {
              const raw = r[sh.orig];
              if (raw && String(raw).trim() !== '') {
                goals.push(...parseGoals(raw));
              }
            }
            goals = Array.from(new Set(goals));

            foundSources.push(`${h} / ${lonKey}`);

            const composedSearch = [
              postIdVal,
              titleVal,
              descVal,
              tagLineVal,
              orgVal,
              // include all original row values too so we catch odd fields
              Object.values(r).join(' ')
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();

            extracted.push({
              id: `${postIdVal ?? rowIndex}-${foundSources.length - 1}-${normalize(h)}`,
              position: [lonNum, latNum],
              row: r,
              sourceField: `${h}/${lonKey}`,
              postId: postIdVal,
              title: String(titleVal ?? ''),
              description: String(descVal ?? ''),
              tagLine: String(tagLineVal ?? ''),
              org: String(orgVal ?? ''),
              goals,
              searchText: composedSearch
            });
          }

          if (foundSources.length === 0) {
            missingRows.push({ idx: rowIndex, postId: r['Post ID'], row: r });
          } else if (foundSources.length > 1) {
            multiPointRows.push({ idx: rowIndex, postId: r['Post ID'], count: foundSources.length, sources: foundSources });
          }
        });

        // build unique goals list (sorted numerically)
        const allGoals = new Set<string>();
        extracted.forEach(p => (p.goals || []).forEach(g => allGoals.add(g)));
        const uniqueSorted = Array.from(allGoals).sort(goalSort);
        setUniqueGoals(uniqueSorted);

        // Now try to merge locations.csv (if present) so we enrich points with city/country
        Papa.parse<Record<string, string>>(locationsCsvUrl, {
          download: true,
          header: true,
          skipEmptyLines: true,
          complete: (locResults) => {
            const locRows = (locResults.data || []) as Array<Record<string, string>>;

            const locByPost = new Map<string, Array<any>>();
            const locByCoord = new Map<string, any>();
            const parseNum = (v?: string) => {
              if (v == null) return undefined;
              const s = String(v).trim();
              if (s === '') return undefined;
              const n = Number(s.replace(',', '.'));
              return Number.isFinite(n) ? n : undefined;
            };

            for (const lr of locRows) {
              const pid = String(lr['post_id'] ?? lr['Post ID'] ?? lr['PostID'] ?? '').trim();
              const lat = parseNum(lr['lat'] ?? lr['latitude'] ?? lr['Latitude']);
              const lon = parseNum(lr['lon'] ?? lr['longitude'] ?? lr['Longitude']);
              const city = (lr['city'] ?? lr['City'] ?? lr['city_name'] ?? '').toString().trim();
              const state = (lr['state'] ?? lr['State'] ?? '').toString().trim();
              const country = (lr['country'] ?? lr['Country'] ?? '').toString().trim();
              const country_code = (lr['country_code'] ?? lr['countryCode'] ?? '').toString().toUpperCase() ?? '';
              const display = (lr['display_name'] ?? lr['display'] ?? '').toString();

              const entry: any = { pid, lat, lon, city, state, country, country_code, display };

              if (pid) {
                const arr = locByPost.get(pid) || [];
                arr.push(entry);
                locByPost.set(pid, arr);
              }
              if (lat != null && lon != null) {
                const k = coordKey(lat, lon, 5);
                if (!locByCoord.has(k)) locByCoord.set(k, entry);
              }
            }

            // Enrich extracted points
            const enriched = extracted.map((p) => {
              const pid = String(p.postId ?? p.row['Post ID'] ?? '').trim();
              let chosen: any = undefined;

              if (pid && locByPost.has(pid)) {
                const candidates = locByPost.get(pid)!;
                if (candidates.length === 1) chosen = candidates[0];
                else {
                  if (p.position && p.position.length === 2) {
                    const [lng, lat] = p.position;
                    let best: any = null;
                    let bestDist = Number.POSITIVE_INFINITY;
                    for (const c of candidates) {
                      if (c.lat == null || c.lon == null) continue;
                      const d = haversineKm(lat, lng, c.lat, c.lon);
                      if (d < bestDist) { bestDist = d; best = c; }
                    }
                    chosen = best || candidates[0];
                  } else {
                    chosen = candidates[0];
                  }
                }
              }

              if (!chosen && p.position && p.position.length === 2) {
                const k = coordKey(p.position[1], p.position[0], 5);
                if (locByCoord.has(k)) chosen = locByCoord.get(k);
              }

              if (chosen) {
                const city = (chosen.city || '').trim();
                const state = (chosen.state || '').trim();
                const country = (chosen.country || '').trim();
                const display = (chosen.display || '').trim();
                const country_code = chosen.country_code || '';

                // derive a human-friendly place: prefer city, then state, then display_name, then country
                const place = city || state || display || country || '';

                // include place in searchable text
                const extra = [city, state, country, display].filter(Boolean).join(' ');
                const newSearchText = ((p.searchText ?? '') + ' ' + extra).trim().toLowerCase();

                return {
                  ...p,
                  // keep original fields for detail breakdown
                  city: city || undefined,
                  state: state || undefined,
                  country: country || undefined,
                  country_code: country_code || undefined,
                  display_name: display || undefined,
                  // new field: a single place string for display
                  place: place || undefined,
                  searchText: newSearchText
                };
              }
              return p;
            });

            // update points state
            setPoints(enriched);

            // build uniqueCities list for UI (optional)
            const allCities = Array.from(new Set(enriched.map(pt => (pt.city || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
            setUniqueCities(allCities);
          },
          error: (err) => {
            console.warn('Could not load locations.csv for merging', err);
            setPoints(extracted);
          }
        });

        // summary logs (kept)
        console.group('CSV → Map validation');
        console.log(`parsed rows: ${rows.length}`);
        console.log(`headers count: ${headers.length}`);
        console.log(`extracted points: ${extracted.length}`);
        console.log(`rows with no coordinates: ${missingRows.length}`);
        console.log(`rows with non-numeric coords: ${numericFailures.length}`);
        console.log(`rows with multiple points: ${multiPointRows.length}`);
        console.groupEnd();
      },
    });
  }, []);

  // debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // memoized filteredPoints for rendering, filtering, and the map update effect
  const filteredPoints = useMemo(() => {
    const goalFilterActive = Array.isArray(activeGoals) && activeGoals.length > 0;
    const q = (debouncedQuery || '').trim();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];

    return points.filter((p) => {
      if (goalFilterActive) {
        const g = p.goals || [];
        if (!g.some(goal => activeGoals.includes(goal))) return false;
      }

      if (activeCity) {
        if (!p.city || p.city.toLowerCase() !== activeCity.toLowerCase()) return false;
      }

      if (terms.length === 0) return true;
      const hay = (p.searchText ?? '').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [points, activeGoals, debouncedQuery, activeCity]);

  // Helper: extract countries from a point
  const extractCountriesFromPoint = (p: Point): string[] => {
    const out: string[] = [];
    const pushFrom = (s?: string) => {
      if (!s) return;
      s.split(/[,;|]+/).map(x => x.trim()).filter(Boolean).forEach(x => out.push(x));
    };

    if (p.country && String(p.country).trim() !== '') {
      pushFrom(String(p.country));
    } else if (p.row) {
      for (const k of Object.keys(p.row)) {
        if (/country/i.test(k)) {
          pushFrom(String(p.row[k]));
        }
      }
    }
    return out;
  };

  // total & filtered unique country counts (memoized)
  const { totalCountriesCount, showingCountriesCount } = useMemo(() => {
    const totalSet = new Set<string>();
    const showSet = new Set<string>();

    points.forEach(p => {
      extractCountriesFromPoint(p).forEach(c => totalSet.add(c.toLowerCase()));
    });
    filteredPoints.forEach(p => {
      extractCountriesFromPoint(p).forEach(c => showSet.add(c.toLowerCase()));
    });

    return { totalCountriesCount: totalSet.size, showingCountriesCount: showSet.size };
  }, [points, filteredPoints]);

  // project counts (unique Post IDs)
  const { totalProjectsCount, showingProjectsCount } = useMemo(() => {
    const totalSet = new Set<string>();
    const showSet = new Set<string>();

    const normalizePid = (p: Point) => {
      const v = String(p.postId ?? p.row?.['Post ID'] ?? p.row?.['post id'] ?? '').trim();
      return v;
    };

    points.forEach(p => {
      const pid = normalizePid(p);
      if (pid) totalSet.add(pid);
    });
    filteredPoints.forEach(p => {
      const pid = normalizePid(p);
      if (pid) showSet.add(pid);
    });

    return { totalProjectsCount: totalSet.size, showingProjectsCount: showSet.size };
  }, [points, filteredPoints]);

  // Initialize MapLibre map once
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;

    const map = new (maplibregl as any).Map({
      container: mapContainerRef.current!,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [0, 0],
      zoom: 1.5
    });

    map.addControl(new (maplibregl as any).NavigationControl(), 'top-right');

    map.on('error', (e: any) => {
      console.warn('Map error', e);
    });

    mapRef.current = map;

    return () => {
      try {
        popupRef.current?.remove();
        mapRef.current?.remove();
        mapRef.current = null;
      } catch (err) {
        console.warn('Error removing map', err);
      }
    };
  }, []);

  // Update source/layer when filteredPoints change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const srcId = 'projects-source';
    const layerId = 'projects-layer';

    const applyGeojson = () => {
      const geojson = {
        type: 'FeatureCollection' as const,
        features: filteredPoints.map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: {
            id: p.id,
            title: p.title ?? '',
            description: p.description ?? '',
            tagLine: p.tagLine ?? '',
            postId: p.postId ?? '',
            org: p.org ?? '',
            goals: p.goals ?? [],
            city: p.city ?? '',
            state: p.state ?? '',
            country: p.country ?? '',
            row: p.row
          },
          geometry: { type: 'Point' as const, coordinates: p.position }
        }))
      };

      try {
        if (map.getSource(srcId)) {
          const src = map.getSource(srcId) as maplibregl.GeoJSONSource;
          src.setData(geojson as any);
        } else {
          map.addSource(srcId, { type: 'geojson', data: geojson });
          map.addLayer({
            id: layerId,
            type: 'circle',
            source: srcId,
            paint: {
              'circle-radius': 10,
              'circle-color': '#007aff',
              'circle-stroke-width': 1,
              'circle-stroke-color': '#ffffff',
              'circle-opacity': 0.95
            }
          });

          // handlers use feature properties (fresh)
          const featureToPoint = (f: any): Point => {
            const props = f.properties || {};
            return {
              id: props.id ?? `${props.postId ?? ''}-${(f.geometry as any)?.coordinates?.[0] ?? 0}-${(f.geometry as any)?.coordinates?.[1] ?? 0}`,
              position: (f.geometry as any).coordinates as [number, number],
              row: (props.row as CsvRow) ?? {},
              sourceField: props.sourceField,
              postId: props.postId ?? '',
              title: props.title ?? '',
              description: props.description ?? '',
              tagLine: props.tagLine ?? '',
              org: props.org ?? '',
              goals: props.goals ?? [],
              city: props.city ?? undefined,
              state: props.state ?? undefined,
              country: props.country ?? undefined
            };
          };

          map.on('mousemove', layerId, (e: any) => {
            if (e.features && e.features.length > 0) {
              map.getCanvas().style.cursor = 'pointer';
              const f = e.features[0];
              const title = f.properties?.title ?? '';
              setHoverInfo({ x: e.point.x, y: e.point.y, text: title || 'Project' });
            }
          });

          map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = '';
            setHoverInfo(null);
          });

          // click handler with multi-feature list popup
          map.on('click', layerId, (e: any) => {
            if (!e.point) return;
            const features = (e.features && e.features.length > 0) ? e.features : map.queryRenderedFeatures(e.point, { layers: [layerId] });
            if (!features || features.length === 0) return;

            // single feature behaves as before
            if (features.length === 1) {
              const f = features[0];
              const coords = (f.geometry as any).coordinates as [number, number];
              const props = f.properties || {};

              if (popupRef.current) {
                try { popupRef.current.remove(); } catch { }
                popupRef.current = null;
              }

              const selectedPoint = featureToPoint(f);

              const container = document.createElement('div');
              container.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial';
              container.style.maxWidth = '280px';

              const titleEl = document.createElement('div');
              titleEl.style.fontWeight = '600';
              titleEl.style.marginBottom = '6px';
              titleEl.textContent = props.title ?? props.org ?? 'Project';
              container.appendChild(titleEl);

              const descEl = document.createElement('div');
              descEl.style.color = '#333';
              descEl.style.fontSize = '12px';
              descEl.style.marginBottom = '8px';
              descEl.textContent = (props.tagLine ?? props.description ?? '').slice(0, 200);
              container.appendChild(descEl);

              const actionsRow = document.createElement('div');
              actionsRow.style.display = 'flex';
              actionsRow.style.gap = '8px';

              const btnSee = document.createElement('button');
              btnSee.textContent = 'See more';
              btnSee.style.cursor = 'pointer';
              btnSee.style.padding = '6px 10px';
              btnSee.style.borderRadius = '6px';
              btnSee.style.border = '1px solid #ddd';
              btnSee.style.background = '#fff';
              btnSee.style.fontSize = '13px';
              btnSee.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const found = points.find(pt => pt.id === selectedPoint.id) ?? selectedPoint;
                const postIdVal = found.postId ?? found.id;
                const allForPost = points.filter(pt => pt.postId && postIdVal && String(pt.postId) === String(postIdVal));
                const mergedSelected = { ...found, allLocations: allForPost.length > 0 ? allForPost : [found] } as Point;
                setSelected(mergedSelected);
                try { popupRef.current?.remove(); } catch { }
              });
              actionsRow.appendChild(btnSee);

              const btnZoom = document.createElement('button');
              btnZoom.textContent = 'Zoom';
              btnZoom.style.cursor = 'pointer';
              btnZoom.style.padding = '6px 10px';
              btnZoom.style.borderRadius = '6px';
              btnZoom.style.border = '1px solid #ddd';
              btnZoom.style.background = '#fff';
              btnZoom.style.fontSize = '13px';
              btnZoom.addEventListener('click', (ev) => {
                ev.stopPropagation();
                try {
                  map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 6), duration: 400 });
                } catch { }
              });
              actionsRow.appendChild(btnZoom);

              container.appendChild(actionsRow);

              popupRef.current = new (maplibregl as any).Popup({ offset: 10, closeOnClick: true })
                .setLngLat(coords)
                .setDOMContent(container)
                .addTo(map);

              try {
                popupRef.current.on('close', () => {
                  btnSee.removeEventListener('click', () => { });
                  btnZoom.removeEventListener('click', () => { });
                });
              } catch { }

              return;
            }

            // multiple features -> scrollable list popup
            if (popupRef.current) {
              try { popupRef.current.remove(); } catch { }
              popupRef.current = null;
            }

            const coords = (features[0].geometry as any).coordinates as [number, number];

            const listContainer = document.createElement('div');
            listContainer.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial';
            listContainer.style.display = 'flex';
            listContainer.style.flexDirection = 'column';
            listContainer.style.maxWidth = 'min(80vw, 640px)';
            listContainer.style.width = 'min(80vw, 640px)';
            listContainer.style.maxHeight = '70vh';
            listContainer.style.boxSizing = 'border-box';
            listContainer.style.padding = '8px';
            listContainer.style.background = '#fff';
            listContainer.style.borderRadius = '8px';

            const header = document.createElement('div');
            header.style.fontWeight = '700';
            header.style.marginBottom = '8px';
            header.textContent = `${features.length} items at this location`;
            listContainer.appendChild(header);

            const listEl = document.createElement('div');
            listEl.style.overflowY = 'auto';
            listEl.style.display = 'flex';
            listEl.style.flexDirection = 'column';
            listEl.style.gap = '6px';
            listEl.style.maxHeight = 'calc(70vh - 64px)';

            const btnCommonStyle = (btn: HTMLButtonElement) => {
              btn.style.fontSize = '13px';
              btn.style.padding = '6px 10px';
              btn.style.cursor = 'pointer';
              btn.style.borderRadius = '6px';
              btn.style.border = '1px solid #ddd';
              btn.style.background = '#fff';
            };

            const featureToPointLocal = (f: any): Point => {
              const props = f.properties || {};
              return {
                id: props.id ?? `${props.postId ?? ''}-${(f.geometry as any)?.coordinates?.[0] ?? 0}-${(f.geometry as any)?.coordinates?.[1] ?? 0}`,
                position: (f.geometry as any).coordinates as [number, number],
                row: (props.row as CsvRow) ?? {},
                sourceField: props.sourceField,
                postId: props.postId ?? '',
                title: props.title ?? '',
                description: props.description ?? '',
                tagLine: props.tagLine ?? '',
                org: props.org ?? '',
                goals: props.goals ?? [],
                city: props.city ?? undefined,
                state: props.state ?? undefined,
                country: props.country ?? undefined
              };
            };

            features.forEach((f: any, idx: number) => {
              const props = f.properties || {};
              const item = document.createElement('div');
              item.style.display = 'flex';
              item.style.justifyContent = 'space-between';
              item.style.alignItems = 'center';
              item.style.padding = '8px';
              item.style.borderRadius = '6px';
              item.style.background = '#fff';
              item.style.boxShadow = '0 1px 0 rgba(0,0,0,0.04)';

              const info = document.createElement('div');
              info.style.flex = '1 1 auto';
              info.style.marginRight = '10px';

              const title = document.createElement('div');
              title.style.fontSize = '14px';
              title.style.fontWeight = '600';
              title.textContent = props.title ?? props.org ?? `Item ${idx + 1}`;
              info.appendChild(title);

              const sub = document.createElement('div');
              sub.style.fontSize = '12px';
              sub.style.color = '#666';
              sub.textContent = (props.city ? props.city + (props.country ? `, ${props.country}` : '') : (props.tagLine ?? '').slice(0, 120));
              info.appendChild(sub);

              item.appendChild(info);

              const actions = document.createElement('div');
              actions.style.display = 'flex';
              actions.style.gap = '8px';
              actions.style.flex = '0 0 auto';

              const seeBtn = document.createElement('button');
              seeBtn.textContent = 'See more';
              btnCommonStyle(seeBtn);
              seeBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const p = featureToPointLocal(f);
                const found = points.find(pt => pt.id === p.id) ?? p;
                const postIdVal = found.postId ?? found.id;
                const allForPost = points.filter(pt => pt.postId && postIdVal && String(pt.postId) === String(postIdVal));
                const mergedSelected = { ...found, allLocations: allForPost.length > 0 ? allForPost : [found] } as Point;
                setSelected(mergedSelected);
                try { popupRef.current?.remove(); } catch { }
              });
              actions.appendChild(seeBtn);

              const zoomBtn = document.createElement('button');
              zoomBtn.textContent = 'Zoom';
              btnCommonStyle(zoomBtn);
              zoomBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const coords = (f.geometry as any).coordinates as [number, number];
                try {
                  map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 6), duration: 300 });
                } catch { }
              });
              actions.appendChild(zoomBtn);

              item.appendChild(actions);

              listEl.appendChild(item);
            });

            listContainer.appendChild(listEl);

            if (features.length > 6) {
              const footer = document.createElement('div');
              footer.style.marginTop = '8px';
              footer.style.fontSize = '12px';
              footer.style.color = '#666';
              footer.textContent = 'Scroll this list to see more items';
              listContainer.appendChild(footer);
            }

            popupRef.current = new (maplibregl as any).Popup({ offset: 10, closeOnClick: true })
              .setLngLat(coords)
              .setDOMContent(listContainer)
              .addTo(map);

            try {
              // focus first button for accessibility
              requestAnimationFrame(() => {
                const first = listContainer.querySelector('button') as HTMLElement | null;
                if (first) first.focus();
              });

              // ensure popup not clipped: nudge map if necessary
              const popupEl = popupRef.current.getElement();
              if (popupEl) {
                requestAnimationFrame(() => {
                  const rect = popupEl.getBoundingClientRect();
                  const pad = 20;
                  const vw = window.innerWidth, vh = window.innerHeight;
                  let dx = 0, dy = 0;
                  if (rect.right > vw - pad) dx = rect.right - (vw - pad);
                  if (rect.left < pad) dx = rect.left - pad;
                  if (rect.top < pad) dy = rect.top - pad;
                  if (rect.bottom > vh - pad) dy = rect.bottom - (vh - pad);
                  if (dx !== 0 || dy !== 0) {
                    try { (map as any).panBy([Math.round(dx), Math.round(dy)], { duration: 250 }); } catch { }
                  }
                });
              }
            } catch { }
          });
        }

        // Fit to filteredPoints if any
        if (filteredPoints.length > 0) {
          const bounds = new (maplibregl as any).LngLatBounds(filteredPoints[0].position, filteredPoints[0].position);
          filteredPoints.forEach((p) => bounds.extend(p.position));
          try {
            map.fitBounds(bounds, { padding: 60, maxZoom: 8, duration: 800 });
          } catch (err) { /* ignore */ }
        }
      } catch (err) {
        console.error('Error applying GeoJSON to map', err);
      }
    };

    try {
      const styleLoaded = typeof (map as any).isStyleLoaded === 'function' ? (map as any).isStyleLoaded() : false;
      if (styleLoaded) applyGeojson();
      else map.once('load', applyGeojson);
    } catch (err) {
      console.warn('Map style not loaded yet, deferring to load event', err);
      map.once('load', applyGeojson);
    }

    return () => {
      // no-op
    };
  }, [filteredPoints, points]);

  // keep popups off the map and prevent page scroll while details overlay is open
  useEffect(() => {
    if (selected) {
      try {
        popupRef.current?.remove();
        popupRef.current = null;
      } catch { }

      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
    return; // no-op when selected is null
  }, [selected]);

  // Summary counts for UI
  const totalCount = points.length;
  const showingCount = filteredPoints.length;

  // Recent posts logic (top 10 by Post Date)
  const tryParseDate = (s?: string | null): Date | null => {
    if (!s) return null;
    const t = String(s).trim();
    if (!t) return null;
    const d1 = new Date(t);
    if (!isNaN(d1.getTime())) return d1;
    try {
      const d2 = new Date(t.replace(' ', 'T') + 'Z');
      if (!isNaN(d2.getTime())) return d2;
    } catch { }
    return null;
  };

  type RecentPost = {
    postId: string;
    title?: string;
    org?: string;
    latestDate: Date | null;
    snippet?: string;
    points: Point[];
  };

  const recentPosts = useMemo(() => {
    const byPost = new Map<string, RecentPost>();
    const normalizePid = (p: Point) => String(p.postId ?? p.row?.['Post ID'] ?? p.row?.['post id'] ?? '').trim();

    for (const p of points) {
      const pid = normalizePid(p) || `__row_${p.row ? (p.row as any)['row_index'] ?? '' : ''}`;
      const row = p.row || {};
      const dateKeys = ['Post Date (UTC)', 'Post Date', 'post date (utc)', 'post date', 'Created (UTC)', 'Created', 'created (utc)'];
      let foundDate: Date | null = null;
      for (const k of dateKeys) {
        if (row[k]) {
          const d = tryParseDate(row[k]);
          if (d) { foundDate = d; break; }
        }
      }

      const existing = byPost.get(pid);
      if (!existing) {
        byPost.set(pid, {
          postId: pid,
          title: p.title ?? (p.row && (p.row['Project'] || p.row['project']) ? String(p.row['Project'] ?? p.row['project']) : undefined),
          org: p.org ?? (p.row && (p.row['Organization name'] || p.row['organization name']) ? String(p.row['Organization name'] ?? p.row['organization name']) : undefined),
          latestDate: foundDate,
          snippet: (p.description ?? p.tagLine ?? '').slice(0, 240),
          points: [p]
        });
      } else {
        existing.points.push(p);
        if (foundDate && (!existing.latestDate || foundDate.getTime() > existing.latestDate.getTime())) {
          existing.latestDate = foundDate;
          if (!existing.title) existing.title = p.title;
          if (!existing.org) existing.org = p.org;
        }
      }
    }

    const arr = Array.from(byPost.values())
      .sort((a, b) => {
        const ta = a.latestDate ? a.latestDate.getTime() : -1;
        const tb = b.latestDate ? b.latestDate.getTime() : -1;
        return tb - ta;
      })
      .slice(0, 10);

    return arr;
  }, [points]);

  const handleRecentClick = (rp: RecentPost) => {
    if (!rp || !rp.points || rp.points.length === 0) return;
    const map = mapRef.current;
    const positions = rp.points.map(p => p.position);
    if (map && positions.length > 0) {
      const bounds = new (maplibregl as any).LngLatBounds(positions[0], positions[0]);
      positions.forEach(pos => bounds.extend(pos));
      try {
        map.fitBounds(bounds, { padding: 80, maxZoom: 9, duration: 600 });
      } catch { }
    }
    const rep = rp.points[0];
    const merged: Point = { ...rep, allLocations: rp.points };
    setSelected(merged);
  };

  return (
    // Outer layout: map column (left) and sidebar (right) as siblings.
    <div className="breakout"> <div className="map-layout"> <div className="map-column">
      {/* Map column (left) */}
      <div style={{ position: 'relative', flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: 6, paddingLeft: 6 }}>
        <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />

        {/* Search box (overlayed above the map) */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            top: 12,
            zIndex: 30,
            width: 'min(720px, 92%)',
            pointerEvents: 'auto'
          }}
        >
          <div style={{ background: 'white', padding: 8, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.08)' }}>
            <input
              type="search"
              placeholder="Search title, description, org, city, etc."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: 6, border: '1px solid #ddd', boxSizing: 'border-box' }}
            />
            {searchQuery && (
              <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
                Searching for: <strong>{searchQuery}</strong>
                <button
                  onClick={() => setSearchQuery('')}
                  style={{ marginLeft: 8, fontSize: 12, padding: '4px 6px' }}
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Goals filter panel (collapsible) - still over the map */}
        <div style={{ position: 'absolute', left: 12, top: 12, zIndex: 20 }}>
          <div style={{ background: 'white', padding: 6, borderRadius: 6, boxShadow: '0 6px 18px rgba(0,0,0,0.08)', minWidth: 220 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Filter by Goal</div>
              <button
                onClick={() => setFilterMinimized((v) => !v)}
                style={{ fontSize: 12, padding: '4px 8px', marginLeft: 8 }}
              >
                {filterMinimized ? 'Open' : 'Minimize'}
              </button>
            </div>

            {filterMinimized ? (
              <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>{activeGoals.length === 0 ? 'All goals' : `${activeGoals.length} selected`}</div>
            ) : (
              <>
                <div style={{ marginTop: 8, maxHeight: '36vh', overflow: 'auto' }}>
                  {uniqueGoals.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#666' }}>Loading goals…</div>
                  ) : (
                    uniqueGoals.map((g) => {
                      const checked = activeGoals.includes(g);
                      return (
                        <label key={g} style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setActiveGoals((prev) => {
                                if (prev.includes(g)) return prev.filter((x) => x !== g);
                                return [...prev, g];
                              });
                            }}
                            style={{ marginRight: 8 }}
                          />
                          {g}
                        </label>
                      );
                    })
                  )}
                </div>
                {uniqueGoals.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button onClick={() => setActiveGoals([])} style={{ fontSize: 12, padding: '6px 8px' }}>
                      Clear
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Hover tooltip */}
        {hoverInfo && (
          <div
            style={{
              position: 'absolute',
              left: hoverInfo.x + 12,
              top: hoverInfo.y + 12,
              pointerEvents: 'none',
              background: 'rgba(255,255,255,0.95)',
              padding: '6px 8px',
              borderRadius: 4,
              boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
              fontSize: 12,
              maxWidth: 300,
              zIndex: 15
            }}
          >
            {hoverInfo.text}
          </div>
        )}

        {/* Full-screen details overlay */}
        {selected && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.55)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 99999
            }}
            onClick={() => setSelected(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(90%, 1100px)',
                maxHeight: '90vh',
                overflow: 'auto',
                background: 'white',
                padding: 20,
                borderRadius: 10,
                boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
                position: 'relative'
              }}
            >
              <button
                onClick={() => setSelected(null)}
                style={{
                  position: 'absolute',
                  right: 12,
                  top: 12,
                  background: 'transparent',
                  border: 'none',
                  fontSize: 16,
                  cursor: 'pointer'
                }}
                aria-label="Close details"
              >
                ✕
              </button>

              <h2 style={{ marginTop: 4 }}>{selected.title ?? selected.org ?? 'Details'}</h2>

              <p>
                <strong>Post ID:</strong> {selected.postId}
              </p>
              <p>
                <strong>Organization:</strong> {selected.org}
              </p>
              <p>
                <strong>Location:</strong> {selected.position[1]}, {selected.position[0]}
              </p>

              {(selected.place || selected.display_name || selected.state || selected.country) && (
                <p>
                  <strong>Place:</strong>{' '}
                  {selected.place
                    ? selected.place
                    : selected.display_name
                      ? selected.display_name
                      : (selected.state ? `${selected.state}${selected.country ? ` — ${selected.country}` : ''}` : selected.country)}
                </p>
              )}

              <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                <strong>Description</strong>
                <div>{selected.description ?? ''}</div>
              </div>

              {selected.allLocations && selected.allLocations.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <strong>All locations</strong>
                  <ul>
                    {selected.allLocations.map((loc, idx) => (
                      <li key={loc.id ?? `${selected.postId}-${idx}`} style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 13 }}>
                          <strong>Coords:</strong> {loc.position[1]}, {loc.position[0]}
                          {(loc.place || loc.display_name || loc.state || loc.country) ? (
                            <span> — {loc.place ? loc.place : loc.display_name ? loc.display_name : (loc.state ? `${loc.state}${loc.country ? `, ${loc.country}` : ''}` : loc.country)}</span>
                          ) : null}
                        </div>
                        {loc.sourceField && <div style={{ fontSize: 12, color: '#666' }}>Source: {loc.sourceField}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selected.goals && selected.goals.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <strong>Goals</strong>
                  <ul>
                    {selected.goals.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Bottom summary bar inside the map column */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 12,
            display: 'flex',
            gap: 10,
            zIndex: 15,
            alignItems: 'center'
          }}
        >
          <div style={{ background: 'rgba(255,255,255,0.95)', padding: '8px 12px', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.08)', fontSize: 13 }}>
            Showing <strong>{showingCount}</strong> of <strong>{totalCount}</strong> points
          </div>

          <div style={{ background: 'rgba(255,255,255,0.95)', padding: '8px 12px', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.08)', fontSize: 13 }}>
            Countries: <strong>{showingCountriesCount}</strong> of <strong>{totalCountriesCount}</strong>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.95)', padding: '8px 12px', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.08)', fontSize: 13 }}>
            Projects: <strong>{showingProjectsCount}</strong> of <strong>{totalProjectsCount}</strong>
          </div>
        </div>
      </div>
    </div>

      {/* Sidebar (outside the map) - lives on the page to the right of the map */}
      <aside className="page-sidebar">
        <div style={{ padding: '6px 4px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700 }}>Recent posts</div>
          <div style={{ fontSize: 12, color: '#666' }}>{recentPosts.length} shown</div>
        </div>

        <div style={{ marginTop: 8 }}>
          {recentPosts.length === 0 && <div style={{ color: '#666', fontSize: 13 }}>No recent posts</div>}
          {recentPosts.map((rp) => (
            <div
              key={rp.postId}
              tabIndex={0}
              role="button"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRecentClick(rp); } }}
              onClick={() => handleRecentClick(rp)}
              style={{
                padding: '10px',
                marginBottom: 10,
                borderRadius: 8,
                cursor: 'pointer',
                background: '#fff',
                boxShadow: '0 1px 0 rgba(0,0,0,0.04)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '1.2' }}>{rp.title ?? rp.org ?? rp.postId}</div>
                <div style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap', marginLeft: 8 }}>
                  {rp.latestDate ? new Date(rp.latestDate).toLocaleString() : 'No date'}
                </div>
              </div>
              {rp.org && <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>{rp.org}</div>}
              {rp.snippet && <div style={{ fontSize: 12, color: '#444', marginTop: 8 }}>{rp.snippet}</div>}
            </div>
          ))}
        </div>
      </aside>
    </div>
    </div>
  );
}