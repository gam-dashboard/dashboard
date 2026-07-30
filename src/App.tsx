import React from 'react'; import VegaLiteChart from './components/VegaLiteChart'; import sample from './data/sample.json';

export default function App() { return ( <div className="app"> <header> <h1>Dashboard — Vega-Lite in React</h1> </header> <main> <VegaLiteChart spec={sample} /> </main> </div> ); }