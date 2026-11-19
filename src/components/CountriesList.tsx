import React, { useEffect, useState } from 'react';
import { ApiCountry, fetchCountriesFromApi } from '../utils/projectApi';

export default function CountriesList(): JSX.Element {
  const [countries, setCountries] = useState<ApiCountry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCountriesFromApi()
      .then((result) => {
        if (cancelled) return;
        setCountries(result.countries);
        setMessage(result.configured ? null : result.message || 'Countries are not available yet.');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load countries');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <details className="countries-list">
      <summary>
        <h2>Countries Represented</h2>
      </summary>
        {loading && <p>Loading countries…</p>}
        {error && <p role="alert">{error}</p>}
        {message && <p>{message}</p>}
        {!loading && !error && !message && (
          <>
            <p>{countries.length} {countries.length === 1 ? 'country' : 'countries'} represented across all projects.</p>
            <table>
              <thead>
                <tr>
                  <th scope="col">Country</th>
                  <th scope="col">Projects</th>
                  <th scope="col">Locations</th>
                </tr>
              </thead>
              <tbody>
                {countries.map((entry) => (
                  <tr key={entry.countryCode || entry.country}>
                    <td>{entry.country}</td>
                    <td>{entry.projectCount}</td>
                    <td>{entry.locationCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
    </details>
  );
}
