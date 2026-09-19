import React, { useEffect, useState } from 'react';
import MapView, { MapViewConfig } from './components/MapView';
import AltDashboard from './pages/waDashboard';
import SyrDashboard from './pages/syrDashboard';
import DataChatbot from './components/DataChatbot';
import './styles.css';

import SDG_CSV_URL from './data/SDG_projects.csv?url';
import LOC_CSV_URL from './data/locations.csv?url';
import CAT_CSV_URL from './data/project_categories.csv?url';
import WA_TRACKER_URL from './data/WA_tracker_entries.csv?url';
import WA_LOC_URL from './data/WA_locations.csv?url';
import SY_CSV_URL from './data/SY_projects.csv?url';
import SY_LOC_URL from './data/SY_locations.csv?url';

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
          
          {/* WA State Chatbot - analyzes health tracker and location data */}
          <section className="chatbot-section">
            <DataChatbot 
              csvFiles={[WA_TRACKER_URL, WA_LOC_URL]}
              title="WA State Health Data Assistant"
            />
          </section>
        </div>
      ) : route === '#/SYProjects' ? (
        <div>
          <SyrDashboard />

          {/* Projects for Syria Chatbot */}
          <section className="chatbot-section">
            <DataChatbot
              csvFiles={[SY_CSV_URL, SY_LOC_URL]}
              title="Syria Projects Intelligence"
            />
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
          
          {/* Global Projects Chatbot - analyzes cross-dataset patterns */}
          <section className="chatbot-section">
            <DataChatbot 
              csvFiles={[SDG_CSV_URL, LOC_CSV_URL, CAT_CSV_URL]}
              title="Global Projects Intelligence"
            />
          </section>
        </div>
      )}
    </div>
  );
}
