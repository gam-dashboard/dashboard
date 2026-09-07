import React from 'react';
import MapView, { MapViewConfig } from '../components/MapView';

// Import alternate CSVs (add these files under src/data/ or public/data)
import altSdgCsvUrl from '../data/WA_tracker_entries.csv?url';
import altUnCivicCsvUrl from '../data/WA_un.csv?url';
import altCategoriesCsvUrl from '../data/WA_categories.csv?url';
import altLocationsCsvUrl from '../data/WA_locations.csv?url';

const altConfig: MapViewConfig = {
  sdgProjectsCsvUrl: altSdgCsvUrl,
  unCivicCsvUrl: altUnCivicCsvUrl,
  projectCategoriesCsvUrl: altCategoriesCsvUrl,
  locationsCsvUrl: altLocationsCsvUrl,
  showGoals: false,
  pageTitle: 'WA Behavioral Health Tracker',
  goalsOpenLabel: 'Open Targets', // won't show because showGoals is false, but left as example
  goalsCloseLabel: 'Close Targets',
  clearLabel: 'Clear selection',
};

export default function AltDashboard(): JSX.Element {
  return (
    <div className="app">
      <header>
        <h1>{altConfig.pageTitle}</h1>
      </header>
      <main>
        <MapView config={altConfig} />
      </main>
    </div>
  );
}