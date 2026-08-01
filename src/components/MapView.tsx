import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import Papa from 'papaparse';
import sampleCsvUrl from '../data/sample.csv?url';
import React, { useEffect, useRef, useState } from 'react';

type CsvRow = Record<string, string>;
type Point = {
  id: string;
  position: [number, number]; // [lng, lat]
  row: CsvRow;
  sourceField?: string;
};

// Public worker path (you copied the file into public/)
const WORKER_PUBLIC_PATH = '/maplibre-gl-worker.mjs'; // or /maplibre-gl-worker.js if that's what you copied

export default function MapView(): JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const [points, setPoints] = useState<Point[]>([]);
  const [selected, setSelected] = useState<Point | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; text: string } | null>(null);

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

  // Parse CSV into points
  useEffect(() => {
    Papa.parse<CsvRow>(sampleCsvUrl, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data as CsvRow[];
        const extracted: Point[] = [];
        rows.forEach((r, rowIndex) => {
          Object.keys(r).forEach((rawKey) => {
            const key = rawKey.trim();
            if (key.toLowerCase().endsWith('.lat')) {
              const prefix = key.slice(0, key.length - 4);
              const lonCandidates = [`${prefix}.lon`, `${prefix}.lng`, `${prefix}.Lon`, `${prefix}.Lng`];
              const lonKey = lonCandidates.find((c) => Object.prototype.hasOwnProperty.call(r, c));
              if (!lonKey) return;
              const latVal = r[key];
              const lonVal = r[lonKey];
              if (!latVal || !lonVal) return;
              const lat = parseFloat(String(latVal).replace(',', '.'));
              const lon = parseFloat(String(lonVal).replace(',', '.'));
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
              const id = `${r['Post ID'] ?? rowIndex}-${prefix}`;
              extracted.push({
                id,
                position: [lon, lat],
                row: r,
                sourceField: `${key}/${lonKey}`
              });
            }
          });
        });
        console.log('Parsed rows:', rows.length, 'extracted points', extracted.length);
        setPoints(extracted);
      },
      error: (err) => {
        console.error('CSV parse error', err);
      }
    });
  }, []);

  // Initialize MapLibre map once
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;

    const map = new (maplibregl as any).Map({
      container: mapContainerRef.current!,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [0, 0],
      zoom: 1.5
    });

    // basic controls
    map.addControl(new (maplibregl as any).NavigationControl(), 'top-right');

    map.on('error', (e: any) => {
      console.warn('Map error', e);
    });

    mapRef.current = map;

    // cleanup on unmount
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

  // When points change, add/update a GeoJSON source and circle layer (wait for style load)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const srcId = 'projects-source';
    const layerId = 'projects-layer';

    const applyGeojson = () => {
      // Build GeoJSON
      const geojson = {
        type: 'FeatureCollection' as const,
        features: points.map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: {
            id: p.id,
            title: p.row['Project'] ?? p.row['Organization name'] ?? '',
            description: p.row['Description'] ?? p.row['Unstructured Description'] ?? '',
            row: p.row
          },
          geometry: { type: 'Point' as const, coordinates: p.position }
        }))
      };

      try {
        // If source exists, just update it
        if (map.getSource(srcId)) {
          const src = map.getSource(srcId) as maplibregl.GeoJSONSource;
          src.setData(geojson as any);
        } else {
          // Add source and layer once
          map.addSource(srcId, { type: 'geojson', data: geojson });
          map.addLayer({
            id: layerId,
            type: 'circle',
            source: srcId,
            paint: {
              // make radius larger while debugging if you can't see points
              'circle-radius': 10,
              'circle-color': '#007aff',
              'circle-stroke-width': 1,
              'circle-stroke-color': '#ffffff',
              'circle-opacity': 0.95
            }
          });

          // Attach event handlers once (only when layer is created)
          map.on('mousemove', layerId, (e: any) => {
            map.getCanvas().style.cursor = 'pointer';
            if (e.features && e.features.length > 0) {
              const f = e.features[0];
              const title = f.properties?.title ?? '';
              setHoverInfo({ x: e.point.x, y: e.point.y, text: title || 'Project' });
            }
          });

          map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = '';
            setHoverInfo(null);
          });

          map.on('click', layerId, (e: any) => {
            if (!e.features || e.features.length === 0) return;
            const f = e.features[0];
            const props = f.properties ?? {};
            const p = points.find((pt) => pt.id === props.id);
            if (p) setSelected(p);

            if (popupRef.current) popupRef.current.remove();
            const coords = (f.geometry as any).coordinates as [number, number];
            popupRef.current = new (maplibregl as any).Popup({ offset: 10 })
              .setLngLat(coords)
              .setHTML(`<strong>${props.title ?? ''}</strong><div style="max-width:240px">${props.description ?? ''}</div>`)
              .addTo(map);
          });
        }

        // Fit to points if any
        if (points.length > 0) {
          const bounds = new (maplibregl as any).LngLatBounds(points[0].position, points[0].position);
          points.forEach((p) => bounds.extend(p.position));
          try {
            map.fitBounds(bounds, { padding: 60, maxZoom: 8, duration: 800 });
          } catch (err) {
            /* ignore fitBounds errors */
          }
        }
      } catch (err) {
        console.error('Error applying GeoJSON to map', err);
      }
    };

    // Wait for style to be ready, otherwise addSource/addLayer will throw
    try {
      const styleLoaded = typeof (map as any).isStyleLoaded === 'function' ? (map as any).isStyleLoaded() : false;
      if (styleLoaded) {
        applyGeojson();
      } else {
        // ensure we only attach one listener
        const onLoad = () => {
          applyGeojson();
        };
        map.once('load', onLoad);
        // cleanup in return below will remove listener if needed
      }
    } catch (err) {
      console.warn('Map style not loaded yet, deferring to load event', err);
      map.once('load', applyGeojson);
    }

    // cleanup: nothing to remove on every points update because we update the source;
    // if you ever want to remove layer/source on unmount you can do that in map cleanup effect
    return () => {
      // no-op (handlers attached only once when layer created)
    };
  }, [points]);

  return (
    <div style={{ position: 'relative', height: '80vh' }}>
      <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />

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
            maxWidth: 300
          }}
        >
          {hoverInfo.text}
        </div>
      )}

      {selected && (
        <div
          style={{
            position: 'absolute',
            right: 12,
            top: 12,
            width: 360,
            maxHeight: '70vh',
            overflow: 'auto',
            background: 'white',
            padding: 12,
            borderRadius: 8,
            boxShadow: '0 6px 18px rgba(0,0,0,0.12)'
          }}
        >
          <button onClick={() => setSelected(null)} style={{ float: 'right' }}>
            Close
          </button>
          <h3 style={{ marginTop: 4 }}>{selected.row['Project'] ?? selected.row['Organization name'] ?? 'Details'}</h3>
          <p>
            <strong>Post ID:</strong> {selected.row['Post ID']}
          </p>
          <p>
            <strong>Organization:</strong> {selected.row['Organization name']}
          </p>
          <p>
            <strong>Location:</strong> {selected.position[1]}, {selected.position[0]}
          </p>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
            <strong>Description</strong>
            <div>{selected.row['Description'] ?? selected.row['Unstructured Description'] ?? ''}</div>
          </div>
        </div>
      )}
    </div>
  );
}