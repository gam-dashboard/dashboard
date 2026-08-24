import React from 'react';
import MapView from './components/MapView';
import './styles.css';

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>Global Action Mosaic — Interactive Dashboard</h1>
      </header>
      <main>
        <MapView />
      </main>
    </div>
  );
}