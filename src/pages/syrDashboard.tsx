import React from 'react';
import MapView, { MapViewConfig } from '../components/MapView';

// Import alternate CSVs (add these files under src/data/ or public/data)
import altSdgCsvUrl from '../data/SY_projects.csv?url';
import altUnCivicCsvUrl from '../data/SY_un.csv?url';
import altCategoriesCsvUrl from '../data/SY_categories.csv?url';
import altLocationsCsvUrl from '../data/SY_locations.csv?url';

const altConfig: MapViewConfig = {
  sdgProjectsCsvUrl: altSdgCsvUrl,
  unCivicCsvUrl: altUnCivicCsvUrl,
  projectCategoriesCsvUrl: altCategoriesCsvUrl,
  locationsCsvUrl: altLocationsCsvUrl,
  showGoals: true,
  pageTitle: 'Projects For Syria',
  goalsOpenLabel: 'Filter by SDG', // won't show because showGoals is false, but left as example
  goalsCloseLabel: 'Filter by SDG',
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