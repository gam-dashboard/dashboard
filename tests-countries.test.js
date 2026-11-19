import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateCountries } from './api/_lib/project-store.js';

const PLACEHOLDER_LAT = 50.112313451247;
const PLACEHOLDER_LON = -116.71875;

test('aggregateCountries groups by country code, counts distinct projects, and skips placeholder/empty rows', () => {
  const rows = [
    { post_id: '1', latitude: 33.3, longitude: 44.4, country: 'Iraq', country_code: 'IQ' },
    { post_id: '1', latitude: 33.4, longitude: 44.5, country: 'Iraq', country_code: 'iq' },
    { post_id: '2', latitude: 36.2, longitude: 37.1, country: 'Syria', country_code: 'SY' },
    { post_id: '3', latitude: PLACEHOLDER_LAT, longitude: PLACEHOLDER_LON, country: 'Canada', country_code: 'CA' },
    { post_id: '4', latitude: 1, longitude: 2, country: '', country_code: '' },
    { post_id: '5', latitude: 3, longitude: 4, country: 'Kenya', country_code: null },
  ];

  assert.deepEqual(aggregateCountries(rows), [
    { country: 'Iraq', countryCode: 'IQ', projectCount: 1, locationCount: 2 },
    { country: 'Kenya', countryCode: undefined, projectCount: 1, locationCount: 1 },
    { country: 'Syria', countryCode: 'SY', projectCount: 1, locationCount: 1 },
  ]);
});

test('aggregateCountries orders by project count before name', () => {
  const rows = [
    { post_id: 'a', latitude: 1, longitude: 1, country: 'Zed', country_code: 'ZZ' },
    { post_id: 'b', latitude: 1, longitude: 1, country: 'Zed', country_code: 'ZZ' },
    { post_id: 'c', latitude: 1, longitude: 1, country: 'Alpha', country_code: 'AA' },
  ];
  assert.deepEqual(aggregateCountries(rows).map((entry) => entry.country), ['Zed', 'Alpha']);
});
