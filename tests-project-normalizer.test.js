import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProjectPayload } from './api/_lib/project-normalizer.js';

const taxonomyValues = (project, taxonomyType) => project.taxonomies
  .filter((entry) => entry.taxonomy_type === taxonomyType)
  .map((entry) => entry.value)
  .sort();

const goalOptions = Array.from({ length: 17 }, (_, index) => ({
  tag: `Goal ${index + 1}: Goal Label ${index + 1}`,
  description: `Description for Goal ${index + 1}`,
}));

test('793-style payload imports only selected result.categories goals', () => {
  const payload = {
    result: {
      id: '793',
      form_id: 3,
      title: 'Project 793',
      content: 'Selection-only taxonomy test',
      categories: [
        { tag: 'Goal 1: Goal Label 1', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 2: Goal Label 2', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 3: Goal Label 3', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 5: Goal Label 5', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 6: Goal Label 6', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 8: Goal Label 8', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 10: Goal Label 10', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 11: Goal Label 11', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 15: Goal Label 15', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 16: Goal Label 16', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 17: Goal Label 17', parent: 'Sustainable Development Goals (SDGs)' },
      ],
      values: [
        {
          label: 'Sustainable Development Goals',
          value: [
            { tag: 'Goal 1: Goal Label 1' },
            { tag: 'Goal 2: Goal Label 2' },
          ],
          options: [
            ...goalOptions,
            { tag: 'Propose Your Own Goal', description: 'Should not be imported' },
          ],
        },
      ],
    },
  };

  const project = normalizeProjectPayload(payload, { sourceFile: '793.json' });
  const goals = taxonomyValues(project, 'goal');

  assert.deepEqual(goals, [
    'Goal 10: Goal Label 10',
    'Goal 11: Goal Label 11',
    'Goal 15: Goal Label 15',
    'Goal 16: Goal Label 16',
    'Goal 17: Goal Label 17',
    'Goal 1: Goal Label 1',
    'Goal 2: Goal Label 2',
    'Goal 3: Goal Label 3',
    'Goal 5: Goal Label 5',
    'Goal 6: Goal Label 6',
    'Goal 8: Goal Label 8',
  ]);
  assert.ok(!goals.includes('Goal 4: Goal Label 4'));
  assert.ok(!goals.includes('Propose Your Own Goal'));
  assert.equal(project.taxonomies.every((entry) => entry.raw_value?.source === 'result.categories'), true);
});

test('789-style payload imports only submitted SDG field values', () => {
  const payload = {
    result: {
      id: '789',
      form_id: 3,
      title: 'Project 789',
      content: 'Field-value taxonomy test',
      values: [
        {
          label: 'Sustainable Development Goals',
          value: [
            { tag: 'Goal 8: Goal Label 8' },
            { tag: 'Goal 9: Goal Label 9' },
            { tag: 'Goal 10: Goal Label 10' },
            { tag: 'Goal 16: Goal Label 16' },
            { tag: 'Goal 17: Goal Label 17' },
          ],
          options: goalOptions,
        },
      ],
    },
  };

  const project = normalizeProjectPayload(payload, { sourceFile: '789.json' });

  assert.deepEqual(taxonomyValues(project, 'goal'), [
    'Goal 10: Goal Label 10',
    'Goal 16: Goal Label 16',
    'Goal 17: Goal Label 17',
    'Goal 8: Goal Label 8',
    'Goal 9: Goal Label 9',
  ]);
  assert.ok(!taxonomyValues(project, 'goal').includes('Goal 1: Goal Label 1'));
});

test('779-style payload keeps selected SDGs, selected category, and existing fields intact', () => {
  const payload = {
    result: {
      id: '779',
      form_id: 5,
      title: 'Project 779',
      content: 'Conference taxonomy test',
      categories: [
        { tag: 'Goal 6: Goal Label 6', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'Goal 13: Goal Label 13', parent: 'Sustainable Development Goals (SDGs)' },
        { tag: 'UN Civil Society Conference 2024', parent: 'Conference categories' },
      ],
      values: [
        {
          label: 'Categories',
          value: [{ tag: 'UN Civil Society Conference 2024' }],
          options: [
            { tag: 'UN Civil Society Conference 2024' },
            { tag: 'Another Conference Category' },
          ],
        },
        {
          label: 'Sustainable Development Goals',
          value: [{ tag: 'Goal 6: Goal Label 6' }, { tag: 'Goal 13: Goal Label 13' }],
          options: goalOptions,
        },
      ],
      location: {
        lat: '33.8938',
        lon: '35.5018',
        city: 'Beirut',
        country: 'Lebanon',
        display_name: 'Beirut, Lebanon',
      },
    },
  };

  const project = normalizeProjectPayload(payload, { sourceFile: '779.json' });

  assert.deepEqual(taxonomyValues(project, 'goal'), [
    'Goal 13: Goal Label 13',
    'Goal 6: Goal Label 6',
  ]);
  assert.deepEqual(taxonomyValues(project, 'category'), ['UN Civil Society Conference 2024']);
  assert.ok(!taxonomyValues(project, 'goal').includes('Goal 1: Goal Label 1'));
  assert.equal(project.title, 'Project 779');
  assert.equal(project.description, 'Conference taxonomy test');
  assert.deepEqual(project.locations, [{
    latitude: 33.8938,
    longitude: 35.5018,
    city: 'Beirut',
    state: '',
    country: 'Lebanon',
    country_code: '',
    display_name: 'Beirut, Lebanon',
    raw_location: payload.result.location,
  }]);
});

test('field categories still import when result.categories only supplies SDGs', () => {
  const payload = {
    result: {
      id: '781',
      form_id: 5,
      title: 'Project 781',
      content: 'Mixed source taxonomy test',
      categories: [
        { tag: 'Goal 6: Goal Label 6', parent: 'Sustainable Development Goals (SDGs)' },
      ],
      values: [
        {
          label: 'Categories',
          value: [{ tag: 'UN Civil Society Conference 2024' }],
          options: [
            { tag: 'UN Civil Society Conference 2024' },
            { tag: 'Another Conference Category' },
          ],
        },
      ],
    },
  };

  const project = normalizeProjectPayload(payload, { sourceFile: '781.json' });

  assert.deepEqual(taxonomyValues(project, 'goal'), ['Goal 6: Goal Label 6']);
  assert.deepEqual(taxonomyValues(project, 'category'), ['UN Civil Society Conference 2024']);
});

test('recognized taxonomy keys still import from unlabeled wrapper objects', () => {
  const payload = {
    result: {
      id: '782',
      form_id: 3,
      title: 'Project 782',
      content: 'Wrapper taxonomy test',
      wrapper: {
        tags: 'Community-led Response',
        'Seeking Resources': 'Funding, Partners',
        metadata: {
          tag: 'Nested metadata tag should not import',
        },
      },
    },
  };

  const project = normalizeProjectPayload(payload, { sourceFile: '782.json' });

  assert.deepEqual(taxonomyValues(project, 'tag'), ['Community-led Response']);
  assert.deepEqual(taxonomyValues(project, 'seeking_resources'), ['Funding', 'Partners']);
  assert.ok(!project.taxonomies.some((entry) => entry.value === 'Nested metadata tag should not import'));
});

test('children-wrapped taxonomy fields prefer submitted collections over display-only value text', () => {
  const payload = {
    result: {
      id: '783',
      form_id: 3,
      title: 'Project 783',
      content: 'Children wrapper taxonomy test',
      sections: [
        {
          children: [
            {
              label: 'Tags',
              value: 'Display only label text',
              values: [{ tag: 'Selected Tag' }],
              options: [{ tag: 'Unselected Tag' }],
            },
          ],
        },
      ],
    },
  };

  const project = normalizeProjectPayload(payload, { sourceFile: '783.json' });

  assert.deepEqual(taxonomyValues(project, 'tag'), ['Selected Tag']);
  assert.ok(!project.taxonomies.some((entry) => entry.value === 'Display only label text'));
  assert.ok(!project.taxonomies.some((entry) => entry.value === 'Unselected Tag'));
});

test('generic nested tags, descriptions, and option catalogs do not produce taxonomy rows', () => {
  const payload = {
    result: {
      id: '900',
      form_id: 3,
      title: 'Project 900',
      content: 'Noise filtering test',
      values: [
        {
          label: 'Providing Resources',
          value: 'Micro-grants; Equipment',
          options: [
            { tag: 'Coaching' },
            { tag: 'Advisory' },
          ],
        },
        {
          label: 'Narrative',
          value: 'Goal 4: Goal Label 4 should stay narrative text, not taxonomy.',
        },
      ],
    },
    nested: {
      tag: 'Arbitrary nested tag',
      description: 'Goal 12: Goal Label 12 hidden in description',
      categories: [
        { tag: 'Metadata Category', description: 'Catalog only' },
      ],
      options: [
        { tag: 'Goal 14: Goal Label 14' },
      ],
    },
  };

  const project = normalizeProjectPayload(payload, { sourceFile: '900.json' });

  assert.deepEqual(taxonomyValues(project, 'providing_resources'), ['Equipment', 'Micro-grants']);
  assert.deepEqual(taxonomyValues(project, 'goal'), []);
  assert.deepEqual(taxonomyValues(project, 'tag'), []);
  assert.deepEqual(taxonomyValues(project, 'category'), []);
  assert.deepEqual(
    [...new Set(project.taxonomies.map((entry) => entry.raw_value?.submitted_value))],
    ['Micro-grants; Equipment']
  );
});
