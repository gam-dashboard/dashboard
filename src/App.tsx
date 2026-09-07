import React, { useEffect, useState } from 'react';
import MapView from './components/MapView';
import AltDashboard from './pages/waDashboard';
import './styles.css';

export default function App() {
  const [route, setRoute] = useState<string>(() => window.location.hash || '#/');

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div>
      <nav style={{ padding: 12, display: 'flex', gap: 12 }}>
        <a href="#/">Global Action Mosaic</a>
        <a href="#/WATracker">WA State Behavioral Health Tracker</a>
      </nav>

      {route === '#/WATracker' ? <AltDashboard /> : (
        <div className="app">
          <header>
            <h1>Global Action Mosaic — Interactive Dashboard</h1>
          </header>
          <main>
            <MapView />
          </main>
        </div>
      )}
    </div>
  );
}