'use strict';

/**
 * analyzer.js
 *
 * Builds a compact in-memory "dataset" for a git repository by running a
 * single `git log --numstat` pass over all non-merge commits reachable
 * from HEAD. The dataset is later used by metrics.js to answer all
 * metric queries (file / directory / repository / commit-set / author).
 *
 * Design notes (matching the COMS3011A test brief):
 *  - Only non-merge commits are considered.
 *  - Rename detection is enabled at a 50% similarity threshold (-M50%).
 *  - Binary files are not measured (numstat reports "-" for them).
 *  - The previous commit of a commit h is its (single) parent; the root
 *    commit's diff is against the empty tree, so every line counts as added.
 *  - Authors are mailmap-resolved by using the %aN / %aE format placeholders.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const zlib = require('zlib');
const fs = require('fs');
const fsp = fs.promises;

const RS = '\x1e';
const US = '\x1f';

/** Spawn git with an explicit --git-dir. Base helper for all git calls. */
function git(gitDir, args, opts = {}) {
  return spawn('git', ['--git-dir', gitDir, ...args], opts);
}

/** Run git and capture stdout (rejects on non-zero exit). */
function gitCapture(gitDir, args) {
  return new Promise((resolve, reject) => {
    const child = git(gitDir, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${err.trim()}`));
    });
  });
}

/** Basic metadata about the repository (HEAD commit, branch, commit count). */
async function getRepoInfo(gitDir) {
  const head = await gitCapture(gitDir, ['rev-parse', 'HEAD']);
  let branch = 'detached HEAD';
  try {
    const b = await gitCapture(gitDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (b) branch = b;
  } catch (_) {
    /* detached HEAD - keep default */
  }
  const countRaw = await gitCapture(gitDir, ['rev-list', '--count', '--no-merges', 'HEAD']);
  const timeRaw = await gitCapture(gitDir, ['log', '-1', '--format=%ct', 'HEAD']);
  return {
    head,
    branch,
    commitCount: parseInt(countRaw, 10) || 0,
    headTime: parseInt(timeRaw, 10) || 0,
  };
}

/** Un-escape a path that git printed in C-style quoting. */
function unquotePath(p) {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const body = p.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const nxt = body[++i];
    switch (nxt) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      default: {
        // octal escapes \NNN
        const oct = body.slice(i, i + 3);
        if (/^[0-7]{3}$/.test(oct)) {
          out += String.fromCharCode(parseInt(oct, 8));
          i += 2;
        } else {
          out += nxt;
        }
      }
    }
  }
  return out;
}

/**
 * Parse a numstat path field. Returns null for a plain path, or
 * { oldPath, newPath } when git rendered a rename.
 *
 * git's rename display (pprint_rename in diff.c) factors out a common prefix
 * that ends with '/' and a common suffix that starts with '/'. A side that is
 * empty is written as nothing, which collapses the slash at the junction:
 *   "old => new"            -> old -> new
 *   "dir/{old => new}.js"   -> dir/old.js -> dir/new.js
 *   "perl/{Git => }/x.pm"   -> perl/Git/x.pm -> perl/x.pm
 */
function parseRenamePath(raw) {
  const p = unquotePath(raw);
  const braceStart = p.indexOf('{');
  if (braceStart !== -1) {
    const braceEnd = p.lastIndexOf('}');
    const inner = braceEnd > braceStart ? p.slice(braceStart + 1, braceEnd) : '';
    const sep = inner.indexOf(' => ');
    if (sep !== -1) {
      const pfx = p.slice(0, braceStart);
      const sfx = p.slice(braceEnd + 1);
      const join = (mid) => {
        if (mid) return pfx + mid + sfx;
        if (pfx.endsWith('/') && sfx.startsWith('/')) return pfx + sfx.slice(1);
        return pfx + sfx;
      };
      return { oldPath: join(inner.slice(0, sep)), newPath: join(inner.slice(sep + 4)) };
    }
  }
  const idx = p.indexOf(' => ');
  if (idx !== -1) return { oldPath: p.slice(0, idx), newPath: p.slice(idx + 4) };
  return null;
}

function fileIdFor(ds, path) {
  let id = ds.fileIndex.get(path);
  if (id === undefined) {
    id = ds.files.length;
    ds.files.push(path);
    ds.fileIndex.set(path, id);
  }
  return id;
}

function authorIdFor(ds, name, email) {
  const key = `${name} <${email}>`;
  let id = ds.authorIndex.get(key);
  if (id === undefined) {
    id = ds.authors.length;
    ds.authors.push({ key, name, email });
    ds.authorIndex.set(key, id);
  }
  return id;
}

function newDataset(gitDir) {
  return {
    gitDir,
    head: null,
    branch: null,
    headTime: 0,
    commits: [], // {h, p, t, ai, s}
    authors: [], // {key, name, email}
    files: [], // path by file id
    dirs: [''], // dir path by dir id (0 = root)
    dirParent: [-1],
    dirDepth: [0],
    ancestors: [], // per file id: [immediate parent dirId, ..., root]
    changes: { c: [], f: [], a: [], d: [] }, // flat arrays: commitIdx, fileId, addedLines, removedLines
    authorIndex: new Map(),
    fileIndex: new Map(),
    dirIndex: new Map([['', 0]]),
  };
}

/** Finalize derived structures: directories, parent links, ancestor chains. */
function finalizeDataset(ds) {
  for (let fid = 0; fid < ds.files.length; fid++) {
    const p = ds.files[fid];
    const ancs = [];
    let idx = p.lastIndexOf('/');
    while (idx >= 0) {
      const dir = p.slice(0, idx);
      let did = ds.dirIndex.get(dir);
      if (did === undefined) {
        did = ds.dirs.length;
        ds.dirs.push(dir);
        ds.dirParent.push(-1); // filled below
        ds.dirDepth.push(0); // filled below
        ds.dirIndex.set(dir, did);
      }
      ancs.push(did);
      idx = dir.lastIndexOf('/');
    }
    ancs.push(0); // root is always an ancestor
    ds.ancestors[fid] = ancs;
  }
  // Directories were discovered walking each file's ancestors from the
  // immediate parent upwards, so a child dir can have a lower id than its
  // parent. Depth must be computed parent-first, which a path-length sort
  // guarantees (a parent path is always a strict prefix of its children).
  const order = [];
  for (let d = 1; d < ds.dirs.length; d++) order.push(d);
  order.sort((a, b) => ds.dirs[a].length - ds.dirs[b].length);
  for (const d of order) {
    const p = ds.dirs[d];
    const idx = p.lastIndexOf('/');
    ds.dirParent[d] = idx < 0 ? 0 : ds.dirIndex.get(p.slice(0, idx));
    ds.dirDepth[d] = idx < 0 ? 1 : ds.dirDepth[ds.dirParent[d]] + 1;
  }
}

/**
 * Build the dataset for a repository.
 * @param {string} gitDir  path to the .git directory (or bare repo)
 * @param {{onProgress?: (parsed:number,total:number)=>void}} hooks
 */
function buildDataset(gitDir, hooks = {}) {
  return new Promise(async (resolve, reject) => {
    let info;
    try {
      info = await getRepoInfo(gitDir);
    } catch (err) {
      return reject(new Error(`Unable to read repository info: ${err.message}`));
    }

    const ds = newDataset(gitDir);
    ds.head = info.head;
    ds.branch = info.branch;
    ds.headTime = info.headTime;

    // Only pass mailmap.blob when a .mailmap exists on HEAD, so that a missing
    // file never causes git to error out.
    const extra = [];
    try {
      await gitCapture(gitDir, ['cat-file', '-e', 'HEAD:.mailmap']);
      extra.push('-c', 'mailmap.blob=HEAD:.mailmap');
    } catch (_) {
      /* no mailmap - manual merging still available in the UI */
    }

    const format = `${RS}%H${US}%P${US}%ct${US}%aN${US}%aE${US}%s`;
    const args = [
      ...extra,
      '-c', 'core.quotePath=false',
      'log', '--no-merges', '--numstat', '-M50%',
      `--format=${format}`,
      'HEAD',
    ];

    const child = git(gitDir, args);
    const rl = readline.createInterface({ input: child.stdout });
    let stderr = '';
    let cur = -1;
    let lastReport = 0;
    const total = info.commitCount;

    rl.on('line', (line) => {
      if (line.startsWith(RS)) {
        const parts = line.slice(1).split(US);
        const h = parts[0] || '';
        if (!/^[0-9a-f]{40}$/.test(h)) return;
        const parents = (parts[1] || '').trim();
        const t = parseInt(parts[2], 10) || 0;
        const name = parts[3] || '';
        const email = parts[4] || '';
        const subject = (parts[5] || '').slice(0, 200);
        const ai = authorIdFor(ds, name, email);
        ds.commits.push({ h, p: parents.split(' ')[0] || '', t, ai, s: subject });
        cur = ds.commits.length - 1;
        if (cur - lastReport >= 500) {
          lastReport = cur;
          if (hooks.onProgress) hooks.onProgress(cur, total);
        }
        return;
      }
      if (cur < 0) return;
      const t1 = line.indexOf('\t');
      if (t1 < 0) return;
      const t2 = line.indexOf('\t', t1 + 1);
      if (t2 < 0) return;
      const aRaw = line.slice(0, t1);
      const dRaw = line.slice(t1 + 1, t2);
      const pathRaw = line.slice(t2 + 1);
      if (!pathRaw) return;
      if (aRaw === '-' || dRaw === '-') return; // binary file - not measured
      const added = parseInt(aRaw, 10);
      const removed = parseInt(dRaw, 10);
      if (Number.isNaN(added) || Number.isNaN(removed)) return;
      const ren = parseRenamePath(pathRaw);
      const path = ren ? ren.newPath : unquotePath(pathRaw);
      if (!path) return;
      // The old side of a rename still becomes a known path (with no changes
      // of its own) so that it appears in listings, as in the reference tool.
      if (ren && ren.oldPath && ren.oldPath !== path) fileIdFor(ds, ren.oldPath);
      const fid = fileIdFor(ds, path);
      ds.changes.c.push(cur);
      ds.changes.f.push(fid);
      ds.changes.a.push(added);
      ds.changes.d.push(removed);
    });

    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => reject(new Error(`Failed to run git: ${err.message}`)));

    rl.on('close', () => {
      child.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`git log failed (${code}): ${stderr.trim()}`));
        }
        try {
          finalizeDataset(ds);
        } catch (err) {
          return reject(err);
        }
        if (hooks.onProgress) hooks.onProgress(ds.commits.length, total);
        resolve(ds);
      });
    });
  });
}

/** Persist a dataset to disk (gzipped JSON). */
async function saveDataset(ds, filePath) {
  const plain = {
    version: 1,
    gitDir: ds.gitDir,
    head: ds.head,
    branch: ds.branch,
    headTime: ds.headTime,
    commits: ds.commits,
    authors: ds.authors,
    files: ds.files,
    dirs: ds.dirs,
    dirParent: ds.dirParent,
    dirDepth: ds.dirDepth,
    ancestors: ds.ancestors,
    changes: ds.changes,
  };
  const json = JSON.stringify(plain);
  const gz = zlib.gzipSync(json, { level: 6 });
  await fsp.writeFile(filePath, gz);
  return gz.length;
}

/** Load a dataset from disk and rebuild its Map indexes. */
async function loadDataset(filePath) {
  const gz = await fsp.readFile(filePath);
  const ds = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  ds.authorIndex = new Map();
  ds.authors.forEach((a, i) => ds.authorIndex.set(a.key, i));
  ds.fileIndex = new Map();
  ds.files.forEach((p, i) => ds.fileIndex.set(p, i));
  ds.dirIndex = new Map();
  ds.dirs.forEach((p, i) => ds.dirIndex.set(p, i));
  return ds;
}

module.exports = {
  buildDataset,
  saveDataset,
  loadDataset,
  getRepoInfo,
  gitCapture,
};
