import React, { useEffect, useState } from 'react';
import MapView, { MapViewConfig } from './components/MapView';
import AltDashboard from './pages/waDashboard';
import SyrDashboard from './pages/syrDashboard';
import DataChatbot from './components/DataChatbot';
import './styles.css';

const globalConfig: MapViewConfig = {
  allowedFormIds: [3, 5],
};

export default function App() {
  const [route, setRoute] = useState<string>(() => window.location.hash || '#/');

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div>
      <nav className="app-nav">
        <a href="#/">Global Action Mosaic</a>
        <a href="#/WATracker">Washington State Tracker</a>
        <a href="#/SYProjects">Syria Projects</a>
        <a href="https://globalactionmosaic.ushahidi.io/map">Submit Your Project Here!</a>
      </nav>

      {route === '#/WATracker' ? (
        <div>
          <AltDashboard />
          <section className="chatbot-section">
            <DataChatbot routeKey="wa" title="WA State Health Data Assistant" />
          </section>
        </div>
      ) : route === '#/SYProjects' ? (
        <div>
          <SyrDashboard />
          <section className="chatbot-section">
            <DataChatbot routeKey="syria" title="Syria Projects Intelligence" />
          </section>
        </div>
      ) : (
        <div className="app">
          <header>
            <h1>Global Action Mosaic — Interactive Dashboard</h1>
          </header>
          <main>
            <MapView config={globalConfig} />
          </main>
          <section className="chatbot-section">
            <DataChatbot routeKey="global" title="Global Projects Intelligence" />
          </section>
        </div>
      )}
    </div>
  );
}
