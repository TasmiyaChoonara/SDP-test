'use strict';

/**
 * index.js - RAT (Repo Analysis Tool) HTTP server.
 */

const path = require('path');
const express = require('express');
const multer = require('multer');
const { Store } = require('./store');
const metrics = require('./metrics');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.RAT_DATA_DIR || path.join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '3000', 10);

const store = new Store(DATA_DIR);

const app = express();
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.tmpDir),
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function parseFilter(query) {
  const from = query.from !== undefined && query.from !== '' ? parseInt(query.from, 10) : null;
  const to = query.to !== undefined && query.to !== '' ? parseInt(query.to, 10) : null;
  let hashes = null;
  if (query.commits) {
    hashes = String(query.commits)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (hashes.length > 5000) hashes = hashes.slice(0, 5000);
  }
  return {
    from: Number.isFinite(from) ? from : null,
    to: Number.isFinite(to) ? to : null,
    hashes,
  };
}

async function loadRepoContext(id) {
  const meta = store.get(id);
  if (!meta) return null;
  const ds = await store.getDataset(id);
  return { meta, ds };
}

function authorIdSet(ds, canArr, authorKey) {
  if (!authorKey) return null;
  const idx = ds.authorIndex.get(authorKey);
  if (idx === undefined) return null;
  const target = canArr[idx];
  const set = new Set();
  for (let i = 0; i < ds.authors.length; i++) if (canArr[i] === target) set.add(i);
  return set;
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

app.use(express.static(path.join(ROOT, 'public')));

app.get('/vendor/chart.js', (req, res) => {
  res.sendFile(path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), (err) => {
    if (err) res.status(404).type('text/plain').send('chart.js not found - run npm install');
  });
});

// ---------------------------------------------------------------------------
// Repository management
// ---------------------------------------------------------------------------

app.get('/api/repos', (req, res) => {
  res.json({ repos: store.list() });
});

app.get('/api/repos/:id', (req, res) => {
  const meta = store.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Repository not found' });
  res.json({ repo: meta });
});

app.post(
  '/api/repos/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No zip file uploaded (field name must be "file").' });
    const name = req.body.name || req.file.originalname;
    try {
      const meta = await store.createFromZip(req.file.path, name);
      res.json({ repo: meta });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

app.post(
  '/api/repos/clone',
  asyncHandler(async (req, res) => {
    const url = String(req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Repository URL is required.' });
    const ok =
      /^(https?|git|ssh|file):\/\//i.test(url) ||
      /^git@[\w.-]+:/i.test(url) ||
      /^[\w.-]+@[\w.-]+:/.test(url) ||
      url.startsWith('/') ||
      url.startsWith('./') ||
      url.startsWith('../');
    if (!ok) {
      return res.status(400).json({ error: 'Unsupported URL. Use an https://, git://, ssh:// or git@host:path URL.' });
    }
    const meta = await store.createFromClone(url, req.body.name ? String(req.body.name) : undefined);
    res.json({ repo: meta });
  })
);

app.post(
  '/api/repos/local',
  asyncHandler(async (req, res) => {
    const p = String(req.body.path || '').trim();
    if (!p) return res.status(400).json({ error: 'Path is required.' });
    const meta = await store.createFromLocal(p);
    res.json({ repo: meta });
  })
);

app.delete(
  '/api/repos/:id',
  asyncHandler(async (req, res) => {
    const ok = await store.delete(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Repository not found' });
    res.json({ ok: true });
  })
);

app.post(
  '/api/repos/:id/reanalyze',
  asyncHandler(async (req, res) => {
    const meta = await store.reanalyze(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Repository not found' });
    res.json({ repo: meta });
  })
);

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

app.get(
  '/api/repos/:id/authors',
  asyncHandler(async (req, res) => {
    const ctx = await loadRepoContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Repository not found' });
    if (!ctx.ds) return res.status(409).json({ error: 'Repository is not analyzed yet' });
    const { ds, meta } = ctx;
    const canArr = metrics.resolveAuthorMerges(ds, meta.authorMerges || {});
    res.json({ authors: metrics.listAuthors(ds, canArr), merges: meta.authorMerges || {} });
  })
);

app.post(
  '/api/repos/:id/authors/merge',
  asyncHandler(async (req, res) => {
    const source = String(req.body.source || '');
    const target = String(req.body.target || '');
    const meta = store.get(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Repository not found' });
    if (!source || !target) return res.status(400).json({ error: 'Both source and target author keys are required.' });
    if (source === target) return res.status(400).json({ error: 'Pick two different authors.' });
    const ds = await store.getDataset(req.params.id);
    if (!ds) return res.status(409).json({ error: 'Repository is not analyzed yet' });
    if (!ds.authorIndex.has(source) || !ds.authorIndex.has(target)) {
      return res.status(400).json({ error: 'Unknown author key.' });
    }
    const merges = meta.authorMerges || {};
    // Cycle guard: target must not resolve back to source.
    let cur = target;
    const seen = new Set();
    while (cur) {
      if (cur === source) return res.status(400).json({ error: 'That merge would create a cycle.' });
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = merges[cur];
    }
    await store.updateMerges(req.params.id, (m) => {
      m[source] = target;
    });
    res.json({ merges: store.get(req.params.id).authorMerges });
  })
);

app.post(
  '/api/repos/:id/authors/unmerge',
  asyncHandler(async (req, res) => {
    const source = String(req.body.source || '');
    const meta = store.get(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Repository not found' });
    await store.updateMerges(req.params.id, (m) => {
      delete m[source];
    });
    res.json({ merges: store.get(req.params.id).authorMerges });
  })
);

// ---------------------------------------------------------------------------
// Commits / objects / metrics
// ---------------------------------------------------------------------------

app.get(
  '/api/repos/:id/commits',
  asyncHandler(async (req, res) => {
    const ctx = await loadRepoContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Repository not found' });
    if (!ctx.ds) return res.status(409).json({ error: 'Repository is not analyzed yet' });
    const { ds, meta } = ctx;
    const canArr = metrics.resolveAuthorMerges(ds, meta.authorMerges || {});
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit || '100', 10) || 100), 500);
    const filter = parseFilter(req.query);
    const authorIds = authorIdSet(ds, canArr, req.query.author || null);
    const out = metrics.listCommits(ds, canArr, {
      offset,
      limit,
      q: req.query.q || '',
      from: filter.from,
      to: filter.to,
      authorIds,
    });
    res.json(out);
  })
);

app.get(
  '/api/repos/:id/search',
  asyncHandler(async (req, res) => {
    const ctx = await loadRepoContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Repository not found' });
    if (!ctx.ds) return res.status(409).json({ error: 'Repository is not analyzed yet' });
    res.json({ results: metrics.searchPaths(ctx.ds, req.query.q || '') });
  })
);

app.get(
  '/api/repos/:id/metrics',
  asyncHandler(async (req, res) => {
    const ctx = await loadRepoContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Repository not found' });
    if (!ctx.ds) return res.status(409).json({ error: 'Repository is not analyzed yet' });
    const { ds, meta } = ctx;
    const canArr = metrics.resolveAuthorMerges(ds, meta.authorMerges || {});

    const kind = String(req.query.kind || 'repo');
    const objectPath = String(req.query.object || '');
    const obj = metrics.resolveObject(ds, kind, objectPath);
    if (!obj) return res.status(404).json({ error: `Object not found: ${objectPath}` });

    const filter = parseFilter(req.query);
    const authorIds = authorIdSet(ds, canArr, req.query.author || null);
    const { sel, n } = metrics.selectCommits(ds, { ...filter, authorIds });

    const withChildren = req.query.children !== '0';
    const withSeries = req.query.series === '1';
    const summary = metrics.computeMetrics(ds, { sel, n, obj, canArr, withChildren, withSeries });

    res.json({
      summary,
      filter: {
        from: filter.from,
        to: filter.to,
        manual: filter.hashes ? filter.hashes.length : 0,
        author: req.query.author || null,
        commitSetSize: n,
      },
    });
  })
);

app.get(
  '/api/repos/:id/children',
  asyncHandler(async (req, res) => {
    const ctx = await loadRepoContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Repository not found' });
    if (!ctx.ds) return res.status(409).json({ error: 'Repository is not analyzed yet' });
    const { ds, meta } = ctx;
    const canArr = metrics.resolveAuthorMerges(ds, meta.authorMerges || {});

    const dir = String(req.query.dir || '');
    const obj = metrics.resolveObject(ds, dir === '' ? 'repo' : 'dir', dir);
    if (!obj) return res.status(404).json({ error: `Directory not found: ${dir}` });

    const filter = parseFilter(req.query);
    const authorIds = authorIdSet(ds, canArr, req.query.author || null);
    const { sel, n } = metrics.selectCommits(ds, { ...filter, authorIds });
    const summary = metrics.computeMetrics(ds, { sel, n, obj, canArr, withChildren: true, withSeries: false });
    res.json({ children: summary.children || [], commitSetSize: n });
  })
);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const message = err && err.message ? err.message : 'Internal error';
  const status = err && err.status ? err.status : 500;
  console.error(`[rat] ${req.method} ${req.originalUrl} -> ${message}`);
  res.status(status).json({ error: message });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

store
  .init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`RAT server running on http://localhost:${PORT}`);
      console.log(`Data directory: ${DATA_DIR}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise storage:', err);
    process.exit(1);
  });
