// .github/scripts/append-samples.js
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');
const parse = require('csv-parse/lib/sync');
const stringify = require('csv-stringify/lib/sync');

async function run() {
  const eventPath = process.argv[2];
  if (!eventPath) throw new Error('Need GITHUB_EVENT_PATH');
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const payload = event.client_payload || {};
  const post_id = String(payload.post_id || payload.id || '').trim();
  if (!post_id) {
    console.log('No post_id in payload; exiting');
    return;
  }

  // Map payload fields to CSV columns — adjust to your CSV schema
  const rowToAdd = {
    'Post ID': post_id,
    'Post Date (UTC)': payload.post_date || payload.postDate || '',
    'lat': (payload.lat != null ? payload.lat : ''),
    'lon': (payload.lon != null ? payload.lon : ''),
    'city': payload.city || '',
    'state': payload.state || '',
    'country': payload.country || '',
    'display_name': payload.display_name || ''
  };

  const csvPath = path.join(process.cwd(), 'data', 'samples.csv'); // adjust path if different
  let existing = [];
  let existingText = '';
  if (fs.existsSync(csvPath)) {
    existingText = fs.readFileSync(csvPath, 'utf8');
    existing = parse(existingText, { columns: true, skip_empty_lines: true });
  } else {
    existing = [];
  }

  // Find existing row by Post ID (case-insensitive)
  const existsIndex = existing.findIndex(r => String((r['Post ID'] ?? r['post_id'] ?? '')).trim() === String(post_id));
  if (existsIndex !== -1) {
    console.log(`Post ID ${post_id} already present — updating row ${existsIndex}`);
    existing[existsIndex] = { ...existing[existsIndex], ...rowToAdd };
  } else {
    console.log(`Appending new post ${post_id}`);
    existing.push(rowToAdd);
  }

  // Optional: keep rows stable order (e.g., by Post ID or Post Date)
  // existing.sort((a,b) => (a['Post ID'] || '').localeCompare(b['Post ID'] || ''));

  const out = stringify(existing, { header: true });
  fs.writeFileSync(csvPath, out, 'utf8');

  // Commit via GitHub API using GITHUB_TOKEN
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY not set');

  // Try to get current file sha so we can update; if not present, create
  let sha;
  try {
    const res = await octokit.repos.getContent({ owner, repo, path: path.posix.join('data', 'samples.csv') });
    sha = res.data.sha;
  } catch (err) {
    // file may not exist yet
    sha = undefined;
  }

  const content = Buffer.from(out, 'utf8').toString('base64');
  const message = existsIndex !== -1 ? `Update sample post ${post_id}` : `Add sample post ${post_id}`;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: path.posix.join('data', 'samples.csv'),
    message,
    content,
    sha,
    committer: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' },
    author: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' }
  });

  console.log('Committed samples.csv update.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});