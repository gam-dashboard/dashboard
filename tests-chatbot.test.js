import test from 'node:test';
import assert from 'node:assert/strict';

import chatHandler from './api/chat.js';
import {
  buildChatContext,
  getChatRouteConfig,
  sanitizeChatMessages,
  sanitizeQuestion,
  selectRelevantProjects,
  summarizeProjectsForChat,
} from './api/_lib/chatbot.js';

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const sampleProjects = [
  {
    postId: '100',
    title: 'Kenya Food Security Project',
    description: 'Supports Nairobi communities with food access and urban farming.',
    tagLine: 'Community food resilience',
    org: 'Food Forward',
    searchText: 'kenya nairobi food security urban farming',
    goals: ['Goal 2: Zero Hunger'],
    categories: ['Agriculture'],
    tags: ['food'],
    locations: [{ country: 'Kenya', city: 'Nairobi', display_name: 'Nairobi, Kenya' }],
    postDate: '2026-08-01T00:00:00.000Z',
    orgWebsite: 'https://example.org',
  },
  {
    postId: '101',
    title: 'Jordan Water Access',
    description: 'Improves water access for refugee communities.',
    tagLine: 'Water resilience',
    org: 'Blue Relief',
    searchText: 'jordan water refugee communities',
    goals: ['Goal 6: Clean Water and Sanitation'],
    categories: ['Water'],
    tags: ['water'],
    locations: [{ country: 'Jordan', city: 'Amman', display_name: 'Amman, Jordan' }],
    postDate: '2026-09-05T00:00:00.000Z',
    orgWebsite: '',
  },
];

test('getChatRouteConfig resolves supported routes', () => {
  assert.deepEqual(getChatRouteConfig('global')?.allowedFormIds, [3, 5]);
  assert.equal(getChatRouteConfig('#/SYProjects')?.routeKey, 'syria');
  assert.deepEqual(getChatRouteConfig('wa')?.allowedFormIds, []);
  assert.equal(getChatRouteConfig('unknown'), null);
});

test('sanitize helpers bound question and history', () => {
  assert.equal(sanitizeQuestion('   hello   world   '), 'hello world');
  const messages = sanitizeChatMessages([
    { role: 'system', content: 'ignore me' },
    { role: 'user', content: ' first ' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'second' },
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
  ]);
});

test('chat context summarizes and selects relevant projects', () => {
  const summary = summarizeProjectsForChat(sampleProjects);
  assert.equal(summary.totalProjects, 2);
  assert.equal(summary.topCountries[0].label, 'Jordan');
  const relevant = selectRelevantProjects(sampleProjects, 'What is happening in Nairobi food programs?');
  assert.equal(relevant[0].postId, '100');

  const context = buildChatContext({
    routeConfig: getChatRouteConfig('global'),
    projects: sampleProjects,
    question: 'food',
  });
  assert.equal(context.route.routeKey, 'global');
  assert.equal(context.summary.totalProjects, 2);
  assert.equal(context.relevantProjects[0].postId, '100');
});

test('chat handler rejects malformed requests before touching external services', async () => {
  let res = createRes();
  await chatHandler({ method: 'GET', body: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.errorCode, 'method_not_allowed');

  res = createRes();
  await chatHandler({ method: 'POST', body: { routeKey: 'global', question: '   ' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.errorCode, 'invalid_request');

  res = createRes();
  await chatHandler({ method: 'POST', body: { routeKey: 'unknown', question: 'hello' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.errorCode, 'invalid_route');
});

test('chat handler reports missing server configuration clearly', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalApiKey = process.env.OPENAI_API_KEY;

  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;

  let res = createRes();
  await chatHandler({ method: 'POST', body: { routeKey: 'global', question: 'hello' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.errorCode, 'database_not_configured');

  process.env.DATABASE_URL = 'postgres://example';
  res = createRes();
  await chatHandler({ method: 'POST', body: { routeKey: 'global', question: 'hello' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.errorCode, 'llm_not_configured');

  if (originalDatabaseUrl == null) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalApiKey == null) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});
