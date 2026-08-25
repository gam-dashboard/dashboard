// src/components/MapView.tsx
import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import Papa from 'papaparse';
import sdgProjectsCsvUrl from '../data/SDG_projects.csv?url';
import unCivicCsvUrl from '../data/un_civic_2024.csv?url';
import locationsCsvUrl from '../data/locations.csv?url';
import projectCategoriesCsvUrl from '../data/project_categories.csv?url';
import React, { useEffect, useRef, useState, useMemo } from 'react';

type CsvRow = Record<string, string>;

type ProjectLocation = {
  id: string;
  postId: string;
  position: [number, number];
  city?: string;
  state?: string;
  country?: string;
  country_code?: string;
  display_name?: string;
};

type Project = {
  postId: string;
  title: string;
  description: string;
  tagLine: string;
  org: string;
  goals: string[];
  categories: string[]; // new
  searchText: string;
  postDate: Date | null;
  row: CsvRow;
  locations: ProjectLocation[];
};

type ProjectMarker = {
  project: Project;
  location: ProjectLocation;
};

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

  // First try to match long-form goals (Goal X: Full description)
  const longMatches = Array.from(s.matchAll(/(Goal\s*\d+\s*:\s*[^;|]+?)(?=Goal\s*\d+|$)/gi))
    .map(m => m[1].trim());
  if (longMatches.length) return Array.from(new Set(longMatches));
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

const makeFieldGetter = (row: CsvRow, headerNormToOrig: Map<string, string[]>) =>
  (candidates: string[]): string => {
    for (const c of candidates) {
      const origs = headerNormToOrig.get(c) || [];
      for (const orig of origs) {
        if (orig != null && row[orig] != null && String(row[orig]).trim() !== '') {
          return String(row[orig]);
        }
      }
    }
    return '';
  };

const derivePlace = (l?: { city?: string; state?: string; display_name?: string; country?: string }): string | undefined =>
  l ? (l.city || l.state || l.display_name || l.country || undefined) : undefined;

const WORKER_PUBLIC_PATH = '/maplibre-gl-worker.mjs';

export default function MapView(): JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const [projects, setProjects] = useState<Map<string, Project>>(new Map());
  const projectsRef = useRef<Map<string, Project>>(projects);
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  const [selected, setSelected] = useState<Project | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<ProjectLocation | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; text: string } | null>(null);

  const [uniqueGoals, setUniqueGoals] = useState<string[]>([]);
  const [activeGoals, setActiveGoals] = useState<string[]>([]);
  const [filterMinimized, setFilterMinimized] = useState<boolean>(true); // used as collapsed/expanded for goals

  // new: categories
  const [uniqueCategories, setUniqueCategories] = useState<string[]>([]);
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [categoriesMinimized, setCategoriesMinimized] = useState<boolean>(true);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');

  const [locationInput, setLocationInput] = useState<string>('');
  const [selectedLocationFilters, setSelectedLocationFilters] = useState<
    { label: string; city?: string; state?: string; country?: string }[]
  >([]);

  const normLabel = (s: string) => String(s || '').trim().toLowerCase();

  const [uniqueCities, setUniqueCities] = useState<string[]>([]);
  const [activeCity, setActiveCity] = useState<string | null>(null);

  // set worker url defensively
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

  const parseCsv = (url: string) => new Promise<{ rows: CsvRow[]; headers: string[] }>((resolve, reject) => {
    Papa.parse<CsvRow>(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data as CsvRow[];
        const headers = results.meta.fields || (rows.length ? Object.keys(rows[0]) : []);
        resolve({ rows, headers });
      },
      error: (err) => reject(err),
    });
  });

  useEffect(() => {
    // load SDG, UN civic, and project categories CSVs
    Promise.all([parseCsv(sdgProjectsCsvUrl), parseCsv(unCivicCsvUrl), parseCsv(projectCategoriesCsvUrl)])
      .then(([a, b, c]) => {
        const rows = [...a.rows, ...b.rows];
        const allHeaders = Array.from(new Set([...(a.headers || []), ...(b.headers || [])]));

        const headerNormToOrig = new Map<string, string[]>();
        for (const h of allHeaders) {
          const n = normalize(h);
          const cur = headerNormToOrig.get(n) || [];
          cur.push(h);
          headerNormToOrig.set(n, cur);
        }

        const sdgHeaders = allHeaders.filter(h => {
          const n = normalize(h);
          return n.includes('sustainable development goal') || n.includes('sdg');
        });

        const byPostId = new Map<string, Project>();
        const missingPostId: number[] = [];
        const duplicatePostId = new Set<string>();

        rows.forEach((r, rowIndex) => {
          const getField = makeFieldGetter(r, headerNormToOrig);

          const postId = getField(['post id', 'postid']) || String(r['Post ID'] ?? r['post_id'] ?? '').trim();
          if (!postId) { missingPostId.push(rowIndex); return; }
          if (byPostId.has(postId)) { duplicatePostId.add(postId); return; }

          const title = getField(['project', 'project name', 'title', 'project title', 'name']) || getField(['organization name', 'organization']) || postId;
          const description = getField(['description', 'unstructured description', 'summary', 'abstract']);
          const tagLine = getField(['project tag line', 'tagline', 'tag line']);
          const org = getField(['organization name', 'organization', 'partner']);

          let goals: string[] = [];
          for (const h of sdgHeaders) {
            const raw = r[h];
            if (raw && String(raw).trim() !== '') goals.push(...parseGoals(raw));
          }
          goals = Array.from(new Set(goals));

          const dateStr = getField(['post date (utc)', 'post date', 'created (utc)', 'created', 'date']);
          const postDate = dateStr ? tryParseDate(dateStr) : null;

          const searchText = [postId, title, description, tagLine, org, Object.values(r).join(' ')]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          byPostId.set(postId, {
            postId, title, description, tagLine, org, goals, categories: [], searchText, postDate,
            row: r,
            locations: []
          });
        });

        // Attach categories from project_categories.csv (c.rows)
        const catRows = c.rows || [];
        const orphanCatRows: number[] = [];
        catRows.forEach((cr, idx) => {
          const postId = String(cr['Post ID'] ?? cr['post_id'] ?? cr['postId'] ?? cr['postid'] ?? '').trim();
          if (!postId) { orphanCatRows.push(idx); return; }
          const project = byPostId.get(postId);
          if (!project) { orphanCatRows.push(idx); return; }
          const raw = String(cr['Categories'] ?? cr['categories'] ?? cr['Category'] ?? '').trim();
          if (!raw) return;
          const parts = raw.split(/[,;|]+/).map(s => s.trim()).filter(Boolean);
          const existing = new Set(project.categories.map(x => x.toLowerCase()));
          for (const p of parts) {
            if (!existing.has(p.toLowerCase())) {
              project.categories.push(p);
              existing.add(p.toLowerCase());
            }
          }
          // also add categories to searchText
          if (project.categories.length > 0) {
            project.searchText = [project.searchText, project.categories.join(' ')].filter(Boolean).join(' ').toLowerCase();
          }
        });

        const allGoals = new Set<string>();
        byPostId.forEach(p => p.goals.forEach(g => allGoals.add(g)));
        setUniqueGoals(Array.from(allGoals).sort(goalSort));

        // unique categories
        const allCategories = new Set<string>();
        byPostId.forEach(p => p.categories.forEach(cg => allCategories.add(cg)));
        setUniqueCategories(Array.from(allCategories).sort((a, b) => String(a).localeCompare(b)));

        console.group('SDG_projects.csv + un_civic_2024.csv + project_categories.csv → projects');
        console.log(`parsed rows: ${rows.length}`);
        console.log(`projects: ${byPostId.size}`);
        if (missingPostId.length) console.warn(`rows with no Post ID (skipped): ${missingPostId.length}`, missingPostId);
        if (duplicatePostId.size) console.warn(`duplicate Post IDs (kept first row): ${duplicatePostId.size}`, Array.from(duplicatePostId));
        if (orphanCatRows.length) console.warn(`category rows with no matching project post_id: ${orphanCatRows.length}`, orphanCatRows);
        console.groupEnd();

        // attach locations
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

              project.locations.push({
                id: `${postId}::${project.locations.length}`,
                postId,
                position: [lon, lat],
                city: (lr['city'] ?? '').toString().trim() || undefined,
                state: (lr['state'] ?? '').toString().trim() || undefined,
                country: (lr['country'] ?? '').toString().trim() || undefined,
                country_code: (lr['country_code'] ?? '').toString().toUpperCase() || undefined,
                display_name: (lr['display_name'] ?? '').toString().trim() || undefined,
              });
            });

            console.group('locations.csv → attached to projects');
            console.log(`parsed rows: ${locRows.length}`);
            if (orphanRows.length) console.warn(`rows with a post_id not found in projects CSVs: ${orphanRows.length}`, orphanRows);
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
      })
      .catch(err => {
        console.error('Error loading project CSVs', err);
      });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Build location suggestions including multiple granularities and prioritized
  const uniqueLocationOptions = useMemo(() => {
    const seen = new Set<string>();
    type Opt = { label: string; city?: string; state?: string; country?: string; rank: number };
    const out: Opt[] = [];

    const addLabel = (lbl: string, city?: string, state?: string, country?: string, rank = 10) => {
      if (!lbl) return;
      const n = normLabel(lbl);
      if (!n) return;
      if (!seen.has(n)) {
        seen.add(n);
        out.push({ label: lbl, city, state, country, rank });
      }
    };

    projects.forEach((p) => {
      for (const loc of p.locations) {
        const city = loc.city?.trim();
        const state = loc.state?.trim();
        const country = loc.country?.trim();

        // rank: lower = broader first
        // country-only -> rank 0
        // state+country -> rank 1
        // city+country -> rank 2
        // city+state+country -> rank 3
        // display_name / coords -> rank 4

        if (country) addLabel(`${country}`, undefined, undefined, country, 0);
        if (state && country) addLabel(`${state}, ${country}`, undefined, state, country, 1);
        if (city && country) addLabel(`${city}, ${country}`, city, undefined, country, 2);
        if (city && state && country) addLabel(`${city}, ${state}, ${country}`, city, state, country, 3);

        if (!city && !state && !country && loc.display_name) addLabel(loc.display_name, undefined, undefined, undefined, 4);
        if (!city && !state && !country && !loc.display_name) addLabel(`${loc.position[1]}, ${loc.position[0]}`, undefined, undefined, undefined, 4);
      }
    });

    out.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return String(a.label).localeCompare(String(b.label));
    });

    return out.map(o => ({ label: o.label, city: o.city, state: o.state, country: o.country }));
  }, [projects]);

  const addSelectedLocation = (value: string) => {
    const match = uniqueLocationOptions.find(o => normLabel(o.label) === normLabel(value));
    if (!match) return;
    if (selectedLocationFilters.some(f => normLabel(f.label) === normLabel(match.label))) {
      setLocationInput('');
      return;
    }
    setSelectedLocationFilters(prev => [...prev, match]);
    setLocationInput('');
  };

  const removeSelectedLocation = (label: string) => {
    setSelectedLocationFilters(prev => prev.filter(f => normLabel(f.label) !== normLabel(label)));
  };

  const filteredProjects = useMemo(() => {
    const goalFilterActive = activeGoals.length > 0;
    const categoryFilterActive = activeCategories.length > 0;
    const q = debouncedQuery.trim();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];

    return Array.from(projects.values()).filter((p) => {
      if (goalFilterActive && !p.goals.some(g => activeGoals.includes(g))) return false;

      if (categoryFilterActive && !p.categories.some(c => activeCategories.includes(c))) return false;

      if (selectedLocationFilters.length > 0) {
        const hasMatch = p.locations.some(l => {
          return selectedLocationFilters.some(f => {
            const afCity = f.city?.toLowerCase();
            const afState = f.state?.toLowerCase();
            const afCountry = f.country?.toLowerCase();

            const lc = (l.city || '').toLowerCase();
            const ls = (l.state || '').toLowerCase();
            const lco = (l.country || '').toLowerCase();

            if (afCity && afCity !== lc) return false;
            if (afState && afState !== ls) return false;
            if (afCountry && afCountry !== lco) return false;
            return true;
          });
        });
        if (!hasMatch) return false;
      }

      if (activeCity && !p.locations.some(l => l.city?.toLowerCase() === activeCity.toLowerCase())) return false;

      if (terms.length > 0 && !terms.every(t => p.searchText.includes(t))) return false;
      return true;
    });
  }, [projects, activeGoals, activeCategories, debouncedQuery, activeCity, selectedLocationFilters]);

  const filteredMarkers = useMemo((): ProjectMarker[] => {
    return filteredProjects.flatMap((project) => {
      const locs = activeCity
        ? project.locations.filter(l => l.city?.toLowerCase() === activeCity.toLowerCase())
        : project.locations;
      return locs.map((location) => ({ project, location }));
    });
  }, [filteredProjects, activeCity]);

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

  const totalCount = useMemo(
    () => Array.from(projects.values()).reduce((sum, p) => sum + p.locations.length, 0),
    [projects]
  );
  const showingCount = filteredMarkers.length;

  const totalProjectsCount = projects.size;
  const showingProjectsCount = filteredProjects.length;

  const recentPosts = useMemo(() => {
    return Array.from(projects.values())
      .slice()
      .sort((a, b) => (b.postDate?.getTime() ?? -1) - (a.postDate?.getTime() ?? -1))
      .slice(0, 10);
  }, [projects]);

  const handleRecentClick = (rp: Project) => {
    if (!rp.locations || rp.locations.length === 0) { setSelected(rp); setSelectedLocation(null); return; }
    const map = mapRef.current;
    const positions = rp.locations.map(l => l.position);
    if (map && positions.length > 0) {
      const bounds = new (maplibregl as any).LngLatBounds(positions[0], positions[0]);
      positions.forEach(pos => bounds.extend(pos));
      try {
        map.fitBounds(bounds, { padding: 80, maxZoom: 9, duration: 600 });
      } catch { /* ignore */ }
    }
    setSelected(rp);
    setSelectedLocation(rp.locations[0]);
  };

  const selectedPlace = derivePlace(selectedLocation ?? undefined);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const srcId = 'projects-source';
    const layerId = 'projects-layer';

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
        setSelected(project);
        setSelectedLocation(location);
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

    const openMultiPopup = (matches: ProjectMarker[]) => {
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
        sub.textContent = (project.tagLine || '').slice(0, 120);
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
          setSelectedLocation(location);
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
      const geojson = {
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

          map.on('mousemove', layerId, (e: any) => {
            if (e.features && e.features.length > 0) {
              map.getCanvas().style.cursor = 'pointer';
              const postId = e.features[0].properties?.postId;
              const project = postId ? projectsRef.current.get(postId) : undefined;
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

            const matches: ProjectMarker[] = features
              .map((f: any) => {
                const project = projectsRef.current.get(f.properties?.postId);
                const location = project?.locations.find(l => l.id === f.properties?.locationId);
                return project && location ? { project, location } : null;
              })
              .filter(Boolean) as ProjectMarker[];

            if (matches.length === 0) return;
            if (matches.length === 1) openSinglePopup(matches[0].project, matches[0].location);
            else openMultiPopup(matches);
          });
        }

        if (filteredMarkers.length > 0) {
          const bounds = new (maplibregl as any).LngLatBounds(filteredMarkers[0].location.position, filteredMarkers[0].location.position);
          filteredMarkers.forEach((m) => bounds.extend(m.location.position));
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
  }, [filteredMarkers, projects]);

  useEffect(() => {
    if (selected) {
      try {
        popupRef.current?.remove();
        popupRef.current = null;
      } catch { /* ignore */ }

      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
    return;
  }, [selected]);

  return (
    <div className="breakout">
      <div className="map-layout">
        <div className="map-column">
          {/* Header above the map: keyword search, location input, goals toggle */}
          <div style={{ padding: '12px', display: 'flex', justifyContent: 'center' }}>
            <div style={{ width: 'min(980px, 96%)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {/* Keyword search */}
              <div style={{ flex: '1 1 0' }}>
                <input
                  type="search"
                  placeholder="Search title, description, org, city, etc."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ width: '100%', padding: '8px', borderRadius: 6, border: '1px solid #ddd', boxSizing: 'border-box' }}
                />
              </div>

              {/* Location input + add/reset */}
              <div style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    list="locations-datalist"
                    value={locationInput}
                    onChange={(e) => setLocationInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addSelectedLocation(locationInput);
                      }
                    }}
                    placeholder='City, state, or country filtering'
                    style={{ flex: '1 1 auto', padding: '8px', borderRadius: 6, border: '1px solid #ddd', boxSizing: 'border-box' }}
                  />
                  <datalist id="locations-datalist">
                    {uniqueLocationOptions.map(o => <option key={o.label} value={o.label} />)}
                  </datalist>

                  <button
                    onClick={() => addSelectedLocation(locationInput)}
                    style={{ padding: '8px 10px', borderRadius: 6, fontSize: 13 }}
                    title="Add location filter"
                  >
                    Add
                  </button>

                  <button
                    onClick={() => {
                      setLocationInput('');
                      setSelectedLocationFilters([]);
                    }}
                    style={{ padding: '8px 10px', borderRadius: 6, fontSize: 13 }}
                    title="Reset location filters"
                  >
                    Reset
                  </button>
                </div>

                {/* chips */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {selectedLocationFilters.length === 0 && <div style={{ color: '#666', fontSize: 12 }}>No location filters</div>}
                  {selectedLocationFilters.map((f) => (
                    <div
                      key={f.label}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        background: '#f1f7ff',
                        border: '1px solid #d6e8ff',
                        padding: '6px 8px',
                        borderRadius: 999,
                        fontSize: 13
                      }}
                    >
                      <input type="checkbox" checked readOnly style={{ width: 14, height: 14 }} />
                      <div style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.label}>
                        {f.label}
                      </div>
                      <button onClick={() => removeSelectedLocation(f.label)} aria-label={`Remove ${f.label}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}>
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Goals toggle and Categories toggle */}
              <div style={{ width: 240 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    onClick={() => setCategoriesMinimized(v => !v)}
                    style={{ padding: '8px 10px', borderRadius: 6, fontSize: 13 }}
                    title="Open Categories"
                  >
                    {categoriesMinimized ? 'Open Categories' : 'Close Categories'}
                  </button>

                  <button
                    onClick={() => setFilterMinimized(v => !v)}
                    style={{ padding: '8px 10px', borderRadius: 6, fontSize: 13 }}
                    title="Open Goals"
                  >
                    {filterMinimized ? 'Open Goals' : 'Close Goals'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Categories panel (like Goals) */}
          {!categoriesMinimized && (
            <div style={{ padding: '0 12px 12px', display: 'flex', justifyContent: 'center' }}>
              <div style={{ width: 'min(980px, 96%)', background: 'white', padding: 8, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.08)' }}>
                <div style={{ maxHeight: '36vh', overflow: 'auto' }}>
                  {uniqueCategories.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#666' }}>Loading categories…</div>
                  ) : (
                    uniqueCategories.map((c) => {
                      const checked = activeCategories.includes(c);
                      return (
                        <label key={c} style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setActiveCategories((prev) => {
                                if (prev.includes(c)) return prev.filter((x) => x !== c);
                                return [...prev, c];
                              });
                            }}
                            style={{ marginRight: 8 }}
                          />
                          {c}
                        </label>
                      );
                    })
                  )}
                </div>
                {uniqueCategories.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button onClick={() => setActiveCategories([])} style={{ fontSize: 12, padding: '6px 8px' }}>
                      Clear
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Goals panel dropdown (appears below header, not overlapping the map) */}
          {!filterMinimized && (
            <div style={{ padding: '0 12px 12px', display: 'flex', justifyContent: 'center' }}>
              <div style={{ width: 'min(980px, 96%)', background: 'white', padding: 8, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.08)' }}>
                <div style={{ maxHeight: '36vh', overflow: 'auto' }}>
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
              </div>
            </div>
          )}

          {/* Map container */}
          <div style={{ position: 'relative', flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 6 }}>
            <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />

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

            {/* Details overlay and bottom summary bars unchanged... */}
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
                onClick={() => { setSelected(null); setSelectedLocation(null); }}
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
                    onClick={() => { setSelected(null); setSelectedLocation(null); }}
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

                  {(selectedPlace || selectedLocation?.display_name || selectedLocation?.state || selectedLocation?.country) && (
                    <p>
                      <strong>Location:</strong>{' '}
                      {selectedLocation?.display_name
                        ? selectedLocation.display_name
                        : selectedPlace
                          ? selectedPlace
                          : (selectedLocation?.state ? `${selectedLocation.state}${selectedLocation.country ? ` — ${selectedLocation.country}` : ''}` : selectedLocation?.country)}
                    </p>
                  )}

                  {selectedLocation && (
                    <p>
                      <strong>Coordinates:</strong> {selectedLocation.position[1]}, {selectedLocation.position[0]}
                    </p>
                  )}

                  <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                    <strong>Description</strong>
                    <div>{selected.description || ''}</div>
                  </div>

                  {selected.locations.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <strong>All locations</strong>
                      <ul>
                        {selected.locations.map((loc) => {
                          const place = derivePlace(loc);
                          return (
                            <li key={loc.id} style={{ marginBottom: 6 }}>
                              <div style={{ fontSize: 13 }}>
                                {(loc.display_name || place || loc.state || loc.country) ? (
                                  <span> {loc.display_name ? loc.display_name : place ? place : (loc.state ? `${loc.state}${loc.country ? `, ${loc.country}` : ''}` : loc.country)} —  </span>
                                ) : null}
                                {loc.position[1]}, {loc.position[0]}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

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

                  {selected.categories && selected.categories.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <strong>Categories</strong>
                      <ul>
                        {selected.categories.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Bottom summary bar */}
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

        {/* Sidebar */}
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
                {(rp.tagLine || rp.description) && (
                  <div style={{ fontSize: 12, color: '#444', marginTop: 8 }}>
                    {(rp.tagLine || rp.description).slice(0, 240)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}