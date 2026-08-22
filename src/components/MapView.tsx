import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import Papa from 'papaparse';
import sampleCsvUrl from '../data/sample.csv?url';
import locationsCsvUrl from '../data/locations.csv?url';
import React, { useEffect, useRef, useState, useMemo } from 'react';

type CsvRow = Record<string, string>;

/** One geographic point for a project, sourced from a single locations.csv row. */
type ProjectLocation = {
  id: string; // stable id: `${postId}::${index within this project}`
  postId: string;
  position: [number, number]; // [lon, lat] — matches maplibre convention
  city?: string;
  state?: string;
  country?: string;
  country_code?: string;
  display_name?: string;
  sourceField?: string; // `${lat_header}/${lon_header}` from locations.csv, if present
};

/** One project/post, sourced from a single sample.csv row (keyed by Post ID),
 *  carrying every matching locations.csv row under `.locations`. */
type Project = {
  postId: string;
  title: string;
  description: string;
  tagLine: string;
  org: string;
  goals: string[];
  searchText: string;
  postDate: Date | null;
  row: CsvRow; // original sample.csv row, for anything not modeled above
  locations: ProjectLocation[];
};

/** A single map marker: a project's location plus a back-reference to the
 *  project it belongs to. */
type ProjectMarker = {
  project: Project;
  location: ProjectLocation;
};

// ---- module-level helpers (pure — no reason to recreate these every render) ----

const normalize = (s: string) =>
  String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const goalSort = (a: string, b: string) => {
  const num = (s: string) => {
    const m = String(s).match(/(\d{1,2})/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  const na = num(a), nb = num(b);
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
};

const parseGoals = (raw: string | undefined): string[] => {
  if (!raw) return [];
  const s = String(raw).replace(/\r?\n/g, ' ').trim();
  if (!s) return [];
  const longMatches = Array.from(s.matchAll(/(Goal\s*\d+\s*:\s*[^,;]+)/gi)).map(m => m[1].trim());
  if (longMatches.length) return Array.from(new Set(longMatches));
  const shortMatches = Array.from(s.matchAll(/(Goal\s*\d+)/gi)).map(m => m[1].trim());
  if (shortMatches.length) return Array.from(new Set(shortMatches));
  const parts = s.split(/[,;|]+/).map(p => p.trim()).filter(Boolean);
  return Array.from(new Set(parts));
};

const tryParseDate = (s?: string | null): Date | null => {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  const d1 = new Date(t);
  if (!isNaN(d1.getTime())) return d1;
  try {
    const d2 = new Date(t.replace(' ', 'T') + 'Z');
    if (!isNaN(d2.getTime())) return d2;
  } catch { /* ignore */ }
  return null;
};

const parseNum = (v?: string): number | undefined => {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s === '') return undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};

/** Best single human-readable label for a location: city, then state, then
 *  the geocoder's display_name, then country. Derived rather than stored,
 *  so it can't drift out of sync with its source fields. */
const placeLabel = (loc: ProjectLocation): string =>
  loc.city || loc.state || loc.display_name || loc.country || '';

const snippetFor = (p: Project): string => (p.description || p.tagLine || '').slice(0, 240);

const WORKER_PUBLIC_PATH = '/maplibre-gl-worker.mjs';

export default function MapView(): JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  // `projects` is the single source of truth, keyed by Post ID so any lookup
  // (e.g. on marker click) is O(1) instead of an array scan.
  const [projects, setProjects] = useState<Map<string, Project>>(new Map());
  const [selected, setSelected] = useState<Project | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; text: string } | null>(null);

  // filter UI state
  const [uniqueGoals, setUniqueGoals] = useState<string[]>([]);
  const [activeGoals, setActiveGoals] = useState<string[]>([]);
  const [filterMinimized, setFilterMinimized] = useState<boolean>(true); // start minimized

  // search queries
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');

  // city enrichment / UI (uniqueCities is populated but, same as the
  // original file, there's no control wired up to set activeCity yet)
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

  // ---- Load sample.csv -> Project metadata keyed by Post ID, then load
  // ---- locations.csv -> attach every matching row as a location ----
  useEffect(() => {
    Papa.parse<CsvRow>(sampleCsvUrl, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data as CsvRow[];
        const headers = results.meta.fields || (rows.length ? Object.keys(rows[0]) : []);
        const sdgHeaders = headers.filter(h => {
          const n = normalize(h);
          return n.includes('sustainable development goal') || n.includes('sdg');
        });

        const byPostId = new Map<string, Project>();
        const missingPostId: number[] = [];
        const duplicatePostId = new Set<string>();

        rows.forEach((r, rowIndex) => {
          const postId = String(r['Post ID'] ?? r['post id'] ?? r['PostID'] ?? '').trim();
          if (!postId) { missingPostId.push(rowIndex); return; }
          if (byPostId.has(postId)) { duplicatePostId.add(postId); return; } // keep first occurrence

          const title = String(r['Project'] ?? r['project'] ?? '');
          const description = String(r['Description'] ?? r['Unstructured Description'] ?? '');
          const tagLine = String(r['Project Tag Line'] ?? '');
          const org = String(r['Organization Name'] ?? r['Organization'] ?? '');

          let goals: string[] = [];
          for (const h of sdgHeaders) {
            const raw = r[h];
            if (raw && String(raw).trim() !== '') goals.push(...parseGoals(raw));
          }
          goals = Array.from(new Set(goals));

          const dateKeys = ['Post Date (UTC)', 'Post Date', 'Created (UTC)', 'Created'];
          let postDate: Date | null = null;
          for (const k of dateKeys) {
            if (r[k]) { const d = tryParseDate(r[k]); if (d) { postDate = d; break; } }
          }

          const searchText = [postId, title, description, tagLine, org, Object.values(r).join(' ')]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          byPostId.set(postId, {
            postId, title, description, tagLine, org, goals, searchText, postDate,
            row: r,
            locations: []
          });
        });

        const allGoals = new Set<string>();
        byPostId.forEach(p => p.goals.forEach(g => allGoals.add(g)));
        setUniqueGoals(Array.from(allGoals).sort(goalSort));

        console.group('sample.csv → projects');
        console.log(`parsed rows: ${rows.length}`);
        console.log(`projects: ${byPostId.size}`);
        if (missingPostId.length) console.warn(`rows with no Post ID (skipped): ${missingPostId.length}`, missingPostId);
        if (duplicatePostId.size) console.warn(`duplicate Post IDs (kept first row): ${duplicatePostId.size}`, Array.from(duplicatePostId));
        console.groupEnd();

        // Attach locations.csv rows to their project via post_id.
        Papa.parse<CsvRow>(locationsCsvUrl, {
          download: true,
          header: true,
          skipEmptyLines: true,
          complete: (locResults) => {
            const locRows = (locResults.data || []) as CsvRow[];
            const orphanRows: number[] = [];
            const badCoordRows: number[] = [];

            locRows.forEach((lr, idx) => {
              const postId = String(lr['post_id'] ?? lr['Post ID'] ?? lr['PostID'] ?? '').trim();
              const project = postId ? byPostId.get(postId) : undefined;
              if (!project) { orphanRows.push(idx); return; }

              const lat = parseNum(lr['lat'] ?? lr['latitude'] ?? lr['Latitude']);
              const lon = parseNum(lr['lon'] ?? lr['longitude'] ?? lr['Longitude']);
              if (lat == null || lon == null) { badCoordRows.push(idx); return; }

              const latHeader = (lr['lat_header'] ?? '').toString().trim();
              const lonHeader = (lr['lon_header'] ?? '').toString().trim();

              project.locations.push({
                id: `${postId}::${project.locations.length}`,
                postId,
                position: [lon, lat],
                city: (lr['city'] ?? lr['City'] ?? '').toString().trim() || undefined,
                state: (lr['state'] ?? lr['State'] ?? '').toString().trim() || undefined,
                country: (lr['country'] ?? lr['Country'] ?? '').toString().trim() || undefined,
                country_code: (lr['country_code'] ?? lr['countryCode'] ?? '').toString().toUpperCase() || undefined,
                display_name: (lr['display_name'] ?? lr['display'] ?? '').toString().trim() || undefined,
                sourceField: (latHeader && lonHeader) ? `${latHeader}/${lonHeader}` : undefined,
              });
            });

            console.group('locations.csv → attached to projects');
            console.log(`parsed rows: ${locRows.length}`);
            if (orphanRows.length) console.warn(`rows with a post_id not found in sample.csv: ${orphanRows.length}`, orphanRows);
            if (badCoordRows.length) console.warn(`rows with non-numeric coordinates: ${badCoordRows.length}`, badCoordRows);
            console.groupEnd();

            setProjects(new Map(byPostId));

            const allCities = Array.from(new Set(
              Array.from(byPostId.values()).flatMap(p => p.locations.map(l => l.city).filter(Boolean) as string[])
            )).sort((a, b) => a.localeCompare(b));
            setUniqueCities(allCities);
          },
          error: (err) => {
            console.warn('Could not load locations.csv — projects will have no locations', err);
            setProjects(new Map(byPostId));
          }
        });
      },
    });
  }, []);

  // debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Filter at the Project level (goals / search / city all live on the
  // project or its locations), then derive the flat marker list for the map.
  const filteredProjects = useMemo(() => {
    const goalFilterActive = activeGoals.length > 0;
    const q = debouncedQuery.trim();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];

    return Array.from(projects.values()).filter((p) => {
      if (goalFilterActive && !p.goals.some(g => activeGoals.includes(g))) return false;
      if (activeCity && !p.locations.some(l => l.city?.toLowerCase() === activeCity.toLowerCase())) return false;
      if (terms.length > 0 && !terms.every(t => p.searchText.includes(t))) return false;
      return true;
    });
  }, [projects, activeGoals, debouncedQuery, activeCity]);

  // Markers to actually plot on the map: one per (project, location) pair.
  // When a city filter is active, only that project's matching location(s)
  // are shown — not all of a multi-location project's other cities.
  const filteredMarkers = useMemo((): ProjectMarker[] => {
    return filteredProjects.flatMap((project) => {
      const locs = activeCity
        ? project.locations.filter(l => l.city?.toLowerCase() === activeCity.toLowerCase())
        : project.locations;
      return locs.map((location) => ({ project, location }));
    });
  }, [filteredProjects, activeCity]);

  // Country extraction: prefer locations.csv's country field; fall back to
  // scanning the original sample.csv row for any "*country*" column.
  const extractCountries = (p: Project): string[] => {
    const fromLocations = p.locations.map(l => l.country).filter(Boolean) as string[];
    if (fromLocations.length) return fromLocations;
    const out: string[] = [];
    for (const k of Object.keys(p.row)) {
      if (/country/i.test(k) && p.row[k]) {
        out.push(...String(p.row[k]).split(/[,;|]+/).map(x => x.trim()).filter(Boolean));
      }
    }
    return out;
  };

  const { totalCountriesCount, showingCountriesCount } = useMemo(() => {
    const totalSet = new Set<string>();
    const showSet = new Set<string>();
    projects.forEach(p => extractCountries(p).forEach(c => totalSet.add(c.toLowerCase())));
    filteredProjects.forEach(p => extractCountries(p).forEach(c => showSet.add(c.toLowerCase())));
    return { totalCountriesCount: totalSet.size, showingCountriesCount: showSet.size };
  }, [projects, filteredProjects]);

  // Project counts (unique Post IDs) — trivial now that data starts
  // pre-grouped, no more Set-building over normalized IDs on every render.
  const totalProjectsCount = projects.size;
  const showingProjectsCount = filteredProjects.length;

  // Marker/point counts — distinct from project counts, since one project
  // can have several locations. This is what "Showing X of Y points" means.
  const totalMarkerCount = useMemo(
    () => Array.from(projects.values()).reduce((sum, p) => sum + p.locations.length, 0),
    [projects]
  );
  const showingMarkerCount = filteredMarkers.length;

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
    map.on('error', (e: any) => console.warn('Map error', e));
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

  // Update source/layer when filteredMarkers change.
  // Feature properties now only carry postId + locationId — everything else
  // is looked up from `projects` (O(1)) instead of being duplicated into
  // every feature and re-derived on every click.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const srcId = 'projects-source';
    const layerId = 'projects-layer';

    const buildGeojson = () => ({
      type: 'FeatureCollection' as const,
      features: filteredMarkers.map(({ project, location }) => ({
        type: 'Feature' as const,
        id: location.id,
        properties: {
          postId: project.postId,
          locationId: location.id,
        },
        geometry: { type: 'Point' as const, coordinates: location.position }
      }))
    });

    const openSinglePopup = (project: Project, location: ProjectLocation) => {
      if (popupRef.current) { try { popupRef.current.remove(); } catch { /* ignore */ } popupRef.current = null; }

      const container = document.createElement('div');
      container.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial';
      container.style.maxWidth = '280px';

      const titleEl = document.createElement('div');
      titleEl.style.fontWeight = '600';
      titleEl.style.marginBottom = '6px';
      titleEl.textContent = project.title || project.org || 'Project';
      container.appendChild(titleEl);

      const descEl = document.createElement('div');
      descEl.style.color = '#333';
      descEl.style.fontSize = '12px';
      descEl.style.marginBottom = '8px';
      descEl.textContent = (project.tagLine || project.description).slice(0, 200);
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
        // No merge/reconstruction needed — the project already has every location.
        setSelected(project);
        try { popupRef.current?.remove(); } catch { /* ignore */ }
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
        try { map.easeTo({ center: location.position, zoom: Math.max(map.getZoom(), 6), duration: 400 }); } catch { /* ignore */ }
      });
      actionsRow.appendChild(btnZoom);

      container.appendChild(actionsRow);

      popupRef.current = new (maplibregl as any).Popup({ offset: 10, closeOnClick: true })
        .setLngLat(location.position)
        .setDOMContent(container)
        .addTo(map);
    };

    const openMultiPopup = (matches: Array<{ project: Project; location: ProjectLocation }>) => {
      if (popupRef.current) { try { popupRef.current.remove(); } catch { /* ignore */ } popupRef.current = null; }

      const coords = matches[0].location.position;
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
      header.textContent = `${matches.length} items at this location`;
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

      matches.forEach(({ project, location }, idx) => {
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
        title.textContent = project.title || project.org || `Item ${idx + 1}`;
        info.appendChild(title);

        const sub = document.createElement('div');
        sub.style.fontSize = '12px';
        sub.style.color = '#666';
        sub.textContent = location.city
          ? location.city + (location.country ? `, ${location.country}` : '')
          : (project.tagLine || '').slice(0, 120);
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
          setSelected(project);
          try { popupRef.current?.remove(); } catch { /* ignore */ }
        });
        actions.appendChild(seeBtn);

        const zoomBtn = document.createElement('button');
        zoomBtn.textContent = 'Zoom';
        btnCommonStyle(zoomBtn);
        zoomBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          try { map.easeTo({ center: location.position, zoom: Math.max(map.getZoom(), 6), duration: 300 }); } catch { /* ignore */ }
        });
        actions.appendChild(zoomBtn);

        item.appendChild(actions);
        listEl.appendChild(item);
      });

      listContainer.appendChild(listEl);

      if (matches.length > 6) {
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

      requestAnimationFrame(() => {
        const first = listContainer.querySelector('button') as HTMLElement | null;
        if (first) first.focus();
      });

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
            try { (map as any).panBy([Math.round(dx), Math.round(dy)], { duration: 250 }); } catch { /* ignore */ }
          }
        });
      }
    };

    const applyGeojson = () => {
      const geojson = buildGeojson();

      try {
        if (map.getSource(srcId)) {
          (map.getSource(srcId) as maplibregl.GeoJSONSource).setData(geojson as any);
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

          map.on('mousemove', layerId, (e: any) => {
            if (e.features && e.features.length > 0) {
              map.getCanvas().style.cursor = 'pointer';
              const postId = e.features[0].properties?.postId;
              const project = postId ? projects.get(postId) : undefined;
              setHoverInfo({ x: e.point.x, y: e.point.y, text: project?.title || 'Project' });
            }
          });

          map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = '';
            setHoverInfo(null);
          });

          map.on('click', layerId, (e: any) => {
            if (!e.point) return;
            const features = (e.features && e.features.length > 0)
              ? e.features
              : map.queryRenderedFeatures(e.point, { layers: [layerId] });
            if (!features || features.length === 0) return;

            // Resolve each feature back to its {project, location} pair via
            // the projects Map — O(1) per feature, no scanning.
            const matches = features
              .map((f: any) => {
                const project = projects.get(f.properties?.postId);
                const location = project?.locations.find(l => l.id === f.properties?.locationId);
                return project && location ? { project, location } : null;
              })
              .filter(Boolean) as Array<{ project: Project; location: ProjectLocation }>;

            if (matches.length === 0) return;
            if (matches.length === 1) openSinglePopup(matches[0].project, matches[0].location);
            else openMultiPopup(matches);
          });
        }

        if (filteredMarkers.length > 0) {
          const bounds = new (maplibregl as any).LngLatBounds(filteredMarkers[0].location.position, filteredMarkers[0].location.position);
          filteredMarkers.forEach(m => bounds.extend(m.location.position));
          try { map.fitBounds(bounds, { padding: 60, maxZoom: 8, duration: 800 }); } catch { /* ignore */ }
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
  }, [filteredMarkers, projects]);

  // keep popups off the map and prevent page scroll while details overlay is open
  useEffect(() => {
    if (selected) {
      try { popupRef.current?.remove(); popupRef.current = null; } catch { /* ignore */ }
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prevOverflow; };
    }
    return;
  }, [selected]);

  // Summary counts for UI — "points" means individual markers (a project
  // can have several); "projects" means unique Post IDs.
  const totalCount = totalMarkerCount;
  const showingCount = showingMarkerCount;

  // Recent posts (top 10 by Post Date). Projects are already grouped by
  // Post ID, so this is just a sort + slice — no re-grouping pass, and
  // (unlike before) a post with metadata but zero locations.csv matches
  // still shows up here instead of silently disappearing.
  const recentPosts = useMemo(() => {
    return Array.from(projects.values())
      .slice()
      .sort((a, b) => (b.postDate?.getTime() ?? -1) - (a.postDate?.getTime() ?? -1))
      .slice(0, 10);
  }, [projects]);

  const handleRecentClick = (rp: Project) => {
    const map = mapRef.current;
    const positions = rp.locations.map(l => l.position);
    if (map && positions.length > 0) {
      const bounds = new (maplibregl as any).LngLatBounds(positions[0], positions[0]);
      positions.forEach(pos => bounds.extend(pos));
      try { map.fitBounds(bounds, { padding: 80, maxZoom: 9, duration: 600 }); } catch { /* ignore */ }
    }
    setSelected(rp);
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

              <h2 style={{ marginTop: 4 }}>{selected.title || selected.org || 'Details'}</h2>

              <p>
                <strong>Post ID:</strong> {selected.postId}
              </p>
              <p>
                <strong>Organization:</strong> {selected.org}
              </p>

              <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                <strong>Description</strong>
                <div>{selected.description}</div>
              </div>

              {/* A project's coordinates/place now live per-location (there
                  can be more than one), so they're shown here rather than
                  as a single top-level "Location"/"Place" line. */}
              <div style={{ marginTop: 12 }}>
                <strong>Locations ({selected.locations.length})</strong>
                {selected.locations.length === 0 ? (
                  <div style={{ fontSize: 13, color: '#666', marginTop: 6 }}>No coordinates on file for this post.</div>
                ) : (
                  <ul>
                    {selected.locations.map((loc) => (
                      <li key={loc.id} style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 13 }}>
                          <strong>Coords:</strong> {loc.position[1]}, {loc.position[0]}
                          {placeLabel(loc) && <span> — {placeLabel(loc)}</span>}
                        </div>
                        {loc.sourceField && <div style={{ fontSize: 12, color: '#666' }}>Source: {loc.sourceField}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {selected.goals.length > 0 && (
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
                <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '1.2' }}>{rp.title || rp.org || rp.postId}</div>
                <div style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap', marginLeft: 8 }}>
                  {rp.postDate ? rp.postDate.toLocaleString() : 'No date'}
                </div>
              </div>
              {rp.org && <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>{rp.org}</div>}
              {snippetFor(rp) && <div style={{ fontSize: 12, color: '#444', marginTop: 8 }}>{snippetFor(rp)}</div>}
            </div>
          ))}
        </div>
      </aside>
    </div>
    </div>
  );
}
