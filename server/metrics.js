'use strict';

/**
 * metrics.js
 *
 * Query engine that computes all metrics defined in the COMS3011A test
 * brief on top of a dataset produced by analyzer.js.
 *
 *  - File metrics:       l+, l-, growth, churn
 *  - Directory metrics:  recursive roll-up of immediate children
 *  - Repository metrics: root directory metrics
 *  - Commit set metrics: sums over h in H, modifications, frequency, churn rate
 *  - Author metrics:     author modifications, author churn, ownership
 */

// ---------------------------------------------------------------------------
// Author merging (manual merges; the automatic .mailmap merge is already
// applied in the dataset because git resolved %aN/%aE through the mailmap).
// ---------------------------------------------------------------------------

/**
 * @param {object} ds       dataset
 * @param {object} merges   { [sourceKey]: targetKey }
 * @returns {Int32Array} mapping raw author id -> canonical author id
 */
function resolveAuthorMerges(ds, merges = {}) {
  const n = ds.authors.length;
  const idxByKey = ds.authorIndex;
  const resolveKey = (key) => {
    let cur = key;
    const seen = new Set();
    while (merges[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = merges[cur];
    }
    return cur;
  };
  const canArr = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const t = idxByKey.get(resolveKey(ds.authors[i].key));
    canArr[i] = t === undefined ? i : t;
  }
  return canArr;
}

/** Rows for the authors panel, including which authors are merged together. */
function listAuthors(ds, canArr) {
  const rows = [];
  const commitCounts = new Int32Array(ds.authors.length);
  const groups = new Map(); // canonical id -> [raw ids]
  for (let i = 0; i < ds.authors.length; i++) {
    const c = canArr[i];
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  }
  for (let i = 0; i < ds.commits.length; i++) commitCounts[ds.commits[i].ai]++;
  for (let i = 0; i < ds.authors.length; i++) {
    const a = ds.authors[i];
    const can = canArr[i];
    rows.push({
      key: a.key,
      name: a.name,
      email: a.email,
      commits: commitCounts[i],
      canonical: can === i,
      canonicalKey: ds.authors[can].key,
      mergedInto: can === i ? null : ds.authors[can].key,
      mergedFrom: (groups.get(i) || []).filter((x) => x !== i).map((x) => ds.authors[x].key),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Commit set selection
// ---------------------------------------------------------------------------

function getHashIndex(ds) {
  if (!ds._hashIndex) {
    ds._hashIndex = new Map();
    for (let i = 0; i < ds.commits.length; i++) ds._hashIndex.set(ds.commits[i].h, i);
  }
  return ds._hashIndex;
}

/**
 * Select the commit set H.
 *  - manual:  hashes given -> those (reachable, non-merge) commits
 *  - range:   from/to -> H_{i,j} = { h : i <= committer-date < j }; `from` only -> H_t
 *  - authorIds is an extra filter on top (used by the author view); it is a
 *    Set of raw author ids so that merged authors are included together
 * @returns {{sel: Uint8Array, n: number}}
 */
function selectCommits(ds, { from = null, to = null, hashes = null, authorIds = null } = {}) {
  const sel = new Uint8Array(ds.commits.length);
  let n = 0;
  const manual = Array.isArray(hashes) && hashes.length > 0;
  let picked = null;
  if (manual) {
    picked = new Set();
    const map = getHashIndex(ds);
    for (const raw of hashes) {
      const h = String(raw).trim().toLowerCase();
      if (!h) continue;
      const full = map.get(h);
      if (full !== undefined) {
        picked.add(full);
        continue;
      }
      if (h.length >= 4) {
        for (let i = 0; i < ds.commits.length; i++) {
          if (ds.commits[i].h.startsWith(h)) {
            picked.add(i);
            break;
          }
        }
      }
    }
  }
  for (let i = 0; i < ds.commits.length; i++) {
    const c = ds.commits[i];
    if (manual) {
      if (!picked.has(i)) continue;
    } else {
      if (from != null && c.t < from) continue;
      if (to != null && c.t >= to) continue;
    }
    if (authorIds && !authorIds.has(c.ai)) continue;
    sel[i] = 1;
    n++;
  }
  return { sel, n };
}

/** Paginated commit list for the manual commit picker / commit view. */
function listCommits(ds, canArr, { offset = 0, limit = 100, q = '', from = null, to = null, authorIds = null } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const picked = [];
  for (let i = 0; i < ds.commits.length; i++) {
    const c = ds.commits[i];
    if (from != null && c.t < from) continue;
    if (to != null && c.t >= to) continue;
    if (authorIds && !authorIds.has(c.ai)) continue;
    const ca = ds.authors[canArr[c.ai]];
    if (needle) {
      const hay = `${c.h}\n${c.s}\n${ca.name}\n${ca.email}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    picked.push(i);
  }
  const total = picked.length;
  const slice = picked.slice(offset, offset + limit);
  const items = slice.map((i) => {
    const c = ds.commits[i];
    const ca = ds.authors[canArr[c.ai]];
    return { hash: c.h, short: c.h.slice(0, 8), t: c.t, author: ca.name, email: ca.email, subject: c.s };
  });
  return { total, items };
}

// ---------------------------------------------------------------------------
// Object resolution and children index
// ---------------------------------------------------------------------------

function baseName(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Resolve an object selector {kind: 'repo'|'dir'|'file', path}.
 * Returns null when the object does not exist.
 */
function resolveObject(ds, kind, path) {
  if (kind === 'file') {
    const fid = ds.fileIndex.get(path);
    if (fid === undefined) return null;
    return { kind: 'file', path, fileId: fid };
  }
  const p = path || '';
  const did = ds.dirIndex.get(p);
  if (did === undefined) return null;
  return { kind: kind === 'file' ? 'file' : kind, path: p, dirId: did };
}

/** Lazy static child index: dirId -> child dir ids / child file ids. */
function getChildrenIndex(ds) {
  if (ds._children) return ds._children;
  const dirsOf = new Array(ds.dirs.length).fill(null);
  const filesOf = new Array(ds.dirs.length).fill(null);
  for (let d = 1; d < ds.dirs.length; d++) {
    const p = ds.dirParent[d];
    (dirsOf[p] || (dirsOf[p] = [])).push(d);
  }
  for (let f = 0; f < ds.files.length; f++) {
    const p = ds.ancestors[f][0];
    (filesOf[p] || (filesOf[p] = [])).push(f);
  }
  ds._children = { dirsOf, filesOf };
  return ds._children;
}

/** Boolean mask of files that are inside the given object. */
function wantedFiles(ds, obj) {
  const mask = new Uint8Array(ds.files.length);
  if (obj.kind === 'file') {
    mask[obj.fileId] = 1;
    return mask;
  }
  const dDepth = ds.dirDepth[obj.dirId];
  for (let f = 0; f < ds.files.length; f++) {
    const ancs = ds.ancestors[f];
    const k = ancs.length - dDepth;
    if (k >= 1 && ancs[k - 1] === obj.dirId) mask[f] = 1;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Core metric computation
// ---------------------------------------------------------------------------

/**
 * Compute commit-set metrics for one object (file / directory / root).
 *
 * @param {object} ds      dataset
 * @param {object} opts
 *   sel         Uint8Array commit selection mask (length = commits)
 *   n           |H|
 *   obj         resolved object ({kind, path, dirId?, fileId?})
 *   canArr      Int32Array raw author id -> canonical author id
 *   withChildren  also compute metrics for immediate children (table view)
 *   withSeries    also return a per-commit series for charts
 *   seriesMax     maximum number of series points (downsampled)
 */
function computeMetrics(ds, opts) {
  const { sel, n, obj, canArr, withChildren = false, withSeries = false, seriesMax = 1500 } = opts;
  const commits = ds.commits;
  const ch = ds.changes;
  const mask = wantedFiles(ds, obj);
  const isFileObj = obj.kind === 'file';

  const nAuthors = ds.authors.length;
  const aAdded = new Float64Array(nAuthors);
  const aRemoved = new Float64Array(nAuthors);
  const aMods = new Int32Array(nAuthors);

  let added = 0;
  let removed = 0;
  let mods = 0;
  let curCommit = -1;
  let lastObjMod = -1;
  let series = withSeries ? [] : null;

  // Children bookkeeping (combined token space; local indexes into rows).
  let rows = null;
  let childSeen = null;
  let childLocalFile = null;
  let childLocalDir = null;
  let dDepth = 0;
  if (withChildren && !isFileObj) {
    const ci = getChildrenIndex(ds);
    const dirIds = ci.dirsOf[obj.dirId] || [];
    const fileIds = ci.filesOf[obj.dirId] || [];
    rows = [];
    for (const d of dirIds) {
      const hasKids = Boolean((ci.dirsOf[d] || []).length || (ci.filesOf[d] || []).length);
      rows.push({ kind: 'dir', path: ds.dirs[d], name: baseName(ds.dirs[d]), _id: d, added: 0, removed: 0, modifications: 0, hasChildren: hasKids });
    }
    for (const f of fileIds) {
      rows.push({ kind: 'file', path: ds.files[f], name: baseName(ds.files[f]), _id: f, added: 0, removed: 0, modifications: 0, hasChildren: false });
    }
    childLocalDir = new Int32Array(ds.dirs.length).fill(-1);
    childLocalFile = new Int32Array(ds.files.length).fill(-1);
    rows.forEach((r, i) => {
      if (r.kind === 'dir') childLocalDir[r._id] = i;
      else childLocalFile[r._id] = i;
    });
    childSeen = new Int32Array(rows.length);
    dDepth = ds.dirDepth[obj.dirId];
  }

  let gen = 0;

  for (let i = 0; i < ch.c.length; i++) {
    const c = ch.c[i];
    if (!sel[c]) continue;
    const f = ch.f[i];
    if (!mask[f]) continue;
    const a = ch.a[i];
    const d = ch.d[i];

    if (c !== curCommit) {
      // First change of this commit on the object: start a new "generation"
      // used to mark per-child modifications once per commit.
      gen++;
      curCommit = c;
    }

    added += a;
    removed += d;

    const cAuthor = canArr[commits[c].ai];
    if (a + d > 0 && lastObjMod !== c) {
      // This commit modifies the object (lambda > 0) -> count once per commit.
      lastObjMod = c;
      mods++;
      aMods[cAuthor]++;
    }
    aAdded[cAuthor] += a;
    aRemoved[cAuthor] += d;

    if (rows) {
      const ancs = ds.ancestors[f];
      const k = ancs.length - dDepth;
      const local = k === 1 ? childLocalFile[f] : childLocalDir[ancs[k - 2]];
      if (local >= 0) {
        rows[local].added += a;
        rows[local].removed += d;
        if (a + d > 0 && childSeen[local] !== gen) {
          childSeen[local] = gen;
          rows[local].modifications++;
        }
      }
    }
  }

  // Build the per-commit series by walking the changes again but grouping by
  // commit; cheaper than tracking during the main loop for large repos.
  if (series) {
    let pc = -1;
    let pa = 0;
    let pd = 0;
    for (let i = 0; i < ch.c.length; i++) {
      const c = ch.c[i];
      if (!sel[c]) continue;
      const f = ch.f[i];
      if (!mask[f]) continue;
      if (c !== pc) {
        if (pc >= 0 && pa + pd > 0) series.push([commits[pc].t, commits[pc].h.slice(0, 8), pa, pd]);
        pc = c;
        pa = 0;
        pd = 0;
      }
      pa += ch.a[i];
      pd += ch.d[i];
    }
    if (pc >= 0 && pa + pd > 0) series.push([commits[pc].t, commits[pc].h.slice(0, 8), pa, pd]);
    if (series.length > seriesMax) {
      const stride = Math.ceil(series.length / seriesMax);
      const out = [];
      for (let i = 0; i < series.length; i += stride) {
        let ta = 0;
        let td = 0;
        for (let j = i; j < Math.min(i + stride, series.length); j++) {
          ta += series[j][2];
          td += series[j][3];
        }
        out.push([series[i][0], series[i][1], ta, td]);
      }
      series = out;
    }
  }

  // Author rows (canonical): commits within H, churn, modifications, ownership.
  const commitsByAuthor = new Int32Array(nAuthors);
  for (let i = 0; i < commits.length; i++) {
    if (sel[i]) commitsByAuthor[canArr[commits[i].ai]]++;
  }
  const churn = added + removed;
  const authors = [];
  for (let ai = 0; ai < nAuthors; ai++) {
    const aChurn = aAdded[ai] + aRemoved[ai];
    if (commitsByAuthor[ai] === 0 && aChurn === 0) continue;
    const a = ds.authors[ai];
    authors.push({
      key: a.key,
      name: a.name,
      email: a.email,
      commits: commitsByAuthor[ai],
      added: aAdded[ai],
      removed: aRemoved[ai],
      churn: aChurn,
      modifications: aMods[ai],
      ownership: churn > 0 ? aChurn / churn : 0,
    });
  }
  authors.sort((x, y) => y.churn - x.churn || y.commits - x.commits || x.name.localeCompare(y.name));

  const summary = {
    kind: obj.kind,
    path: obj.path,
    added,
    removed,
    growth: added - removed,
    churn,
    modifications: mods,
    commits: n,
    frequency: n > 0 ? mods / n : 0,
    churnRate: n > 0 ? churn / n : 0,
    authors,
  };

  if (withChildren && rows) {
    for (const r of rows) {
      r.growth = r.added - r.removed;
      r.churn = r.added + r.removed;
      r.frequency = n > 0 ? r.modifications / n : 0;
      r.churnRate = n > 0 ? r.churn / n : 0;
      delete r._id;
    }
    rows.sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'dir' ? -1 : 1));
    summary.children = rows;
  }
  if (series) summary.series = series;
  return summary;
}

/** Search file and directory paths (for the object quick-search box). */
function searchPaths(ds, query, limit = 50) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const out = [];
  for (let d = 0; d < ds.dirs.length && out.length < limit; d++) {
    if (d === 0) continue;
    if (ds.dirs[d].toLowerCase().includes(q)) out.push({ kind: 'dir', path: ds.dirs[d] });
  }
  for (let f = 0; f < ds.files.length && out.length < limit; f++) {
    if (ds.files[f].toLowerCase().includes(q)) out.push({ kind: 'file', path: ds.files[f] });
  }
  return out;
}

module.exports = {
  resolveAuthorMerges,
  listAuthors,
  getHashIndex,
  selectCommits,
  listCommits,
  resolveObject,
  getChildrenIndex,
  computeMetrics,
  searchPaths,
  baseName,
};
