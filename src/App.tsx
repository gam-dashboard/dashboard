import React, { useEffect, useState } from 'react';
import MapView from './components/MapView';
import AltDashboard from './pages/waDashboard';
import DataChatbot from './components/DataChatbot';
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

      {route === '#/WATracker' ? (
        <div>
          <AltDashboard />
          
          {/* WA State Chatbot - analyzes health tracker and location data */}
          <section style={{ padding: '20px', maxWidth: '1200px', margin: '20px auto' }}>
            <DataChatbot 
              csvFiles={['WA_tracker_entries.csv', 'WA_locations.csv']}
              title="WA State Health Data Assistant"
            />
          </section>
        </div>
      ) : (
        <div className="app">
          <header>
            <h1>Global Action Mosaic — Interactive Dashboard</h1>
          </header>
          <main>
            <MapView />
          </main>
          
          {/* Global Projects Chatbot - analyzes cross-dataset patterns */}
          <section style={{ padding: '20px', maxWidth: '1200px', margin: '20px auto' }}>
            <DataChatbot 
              csvFiles={['SDG_projects.csv', 'locations.csv', 'project_categories.csv']}
              title="Global Projects Intelligence"
            />
          </section>
        </div>
      )}
    </div>
  );
}
