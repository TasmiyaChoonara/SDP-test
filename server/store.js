'use strict';

/**
 * store.js
 *
 * Repository storage: ingestion (zip upload, remote clone, local path),
 * per-repo metadata + status tracking, and an LRU cache of parsed datasets.
 *
 * Layout:
 *   data/repos/<id>/meta.json       repository metadata + status + merges
 *   data/repos/<id>/src/            extracted zip contents
 *   data/repos/<id>/repo.git/       bare clone of a remote repository
 *   data/repos/<id>/dataset.json.gz parsed dataset (analysis cache)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const extract = require('extract-zip');
const analyzer = require('./analyzer');

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'repo';
}

function stripZipExt(name) {
  return String(name || 'repository').replace(/\.zip$/i, '');
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch (_) {
    return false;
  }
}

async function isDirectory(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch (_) {
    return false;
  }
}

/**
 * Locate the .git directory inside an extracted zip (root or nested up to
 * depth 3). Also accepts bare repositories (HEAD + objects + refs).
 * Returns the gitDir path or null.
 */
async function findGitDir(root) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    const dotGit = path.join(dir, '.git');
    if (await isDirectory(dotGit)) return dotGit;
    if (await pathExists(dotGit)) {
      throw new Error(
        '.git is a file (git worktree/linked checkout), which is not supported. ' +
          'Please upload a full clone of the repository.'
      );
    }
    // bare repository?
    const isBare =
      (await pathExists(path.join(dir, 'HEAD'))) &&
      (await isDirectory(path.join(dir, 'objects'))) &&
      (await isDirectory(path.join(dir, 'refs')));
    if (isBare) return dir;
    if (depth < 3) {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && e.name !== 'node_modules') {
          queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
    }
  }
  return null;
}

class Store {
  constructor(dataRoot) {
    this.root = dataRoot;
    this.reposDir = path.join(dataRoot, 'repos');
    this.tmpDir = path.join(dataRoot, 'tmp');
    this.metas = new Map();
    this.datasets = new Map(); // LRU: id -> dataset
    this.maxCached = 4;
    this.analyzing = new Set();
    this.lastStatusWrite = new Map();
  }

  async init() {
    await fsp.mkdir(this.reposDir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
    const entries = await fsp.readdir(this.reposDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.reposDir, e.name, 'meta.json'), 'utf8'));
        this.metas.set(meta.id, meta);
        if (meta.status && ['cloning', 'extracting', 'analyzing'].includes(meta.status.state)) {
          meta.status = { state: 'error', progress: 0, message: 'Interrupted while ingesting - remove and re-add, or hit re-analyze.' };
          await this.saveMeta(meta);
        }
      } catch (_) {
        /* skip unusable directories */
      }
    }
  }

  list() {
    return [...this.metas.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id) {
    return this.metas.get(id) || null;
  }

  async saveMeta(meta) {
    this.metas.set(meta.id, meta);
    await fsp.writeFile(path.join(this.reposDir, meta.id, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  async setStatus(id, status, { throttle = false } = {}) {
    const meta = this.get(id);
    if (!meta) return;
    meta.status = status;
    const now = Date.now();
    const last = this.lastStatusWrite.get(id) || 0;
    if (!throttle || now - last > 400) {
      this.lastStatusWrite.set(id, now);
      await this.saveMeta(meta);
    }
  }

  repoDir(id) {
    return path.join(this.reposDir, id);
  }

  datasetPath(id) {
    return path.join(this.repoDir(id), 'dataset.json.gz');
  }

  newId(name) {
    for (let i = 0; i < 10; i++) {
      const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
      if (!this.metas.has(id)) return id;
    }
    return `${slugify(name)}-${Date.now().toString(36)}`;
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  async createFromZip(zipTmpPath, originalName) {
    const name = stripZipExt(originalName);
    const id = this.newId(name);
    const dir = this.repoDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const meta = {
      id,
      name,
      source: { type: 'zip', detail: originalName },
      gitDir: null,
      createdAt: new Date().toISOString(),
      status: { state: 'extracting', progress: 0, message: 'Extracting zip…' },
      info: null,
      stats: null,
      authorMerges: {},
    };
    await this.saveMeta(meta);
    try {
      const src = path.join(dir, 'src');
      await fsp.mkdir(src, { recursive: true });
      await extract(zipTmpPath, { dir: src });
      const gitDir = await findGitDir(src);
      if (!gitDir) {
        throw new Error(
          'No .git directory found inside the zip. The zip must contain the repository including its .git folder.'
        );
      }
      meta.gitDir = gitDir;
      await this.saveMeta(meta);
      this.startAnalysis(id); // async - status surfaces via polling
      return meta;
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true });
      this.metas.delete(id);
      throw err;
    } finally {
      fsp.rm(zipTmpPath, { force: true }).catch(() => {});
    }
  }

  async createFromClone(url, name) {
    const repoName = name || url.split('/').filter(Boolean).pop().replace(/\.git$/, '');
    const id = this.newId(repoName);
    const dir = this.repoDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const meta = {
      id,
      name: repoName,
      source: { type: 'url', detail: url },
      gitDir: path.join(dir, 'repo.git'),
      createdAt: new Date().toISOString(),
      status: { state: 'cloning', progress: 0, message: 'Cloning repository…' },
      info: null,
      stats: null,
      authorMerges: {},
    };
    await this.saveMeta(meta);
    try {
      await this.cloneBare(url, meta.gitDir, async (progress, message) => {
        await this.setStatus(id, { state: 'cloning', progress, message }, { throttle: true });
      });
      this.startAnalysis(id);
      return meta;
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true });
      this.metas.delete(id);
      throw err;
    }
  }

  cloneBare(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['clone', '--bare', '--progress', url, dest]);
      let stderrTail = '';
      const onData = (buf) => {
        const text = buf.toString();
        stderrTail = (stderrTail + text).slice(-4000);
        const percents = [...text.matchAll(/(\d+)%/g)];
        if (percents.length) {
          const pct = parseInt(percents[percents.length - 1][1], 10);
          const line = text.trim().split('\n').pop() || '';
          onProgress(Math.min(pct / 100, 1), `Cloning… ${line.replace(/\r/g, '').slice(0, 120)}`);
        }
      };
      child.stderr.on('data', onData);
      child.stdout.on('data', onData);
      child.on('error', (err) => reject(new Error(`git clone failed: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone failed (exit ${code}): ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`));
      });
    });
  }

  async createFromLocal(localPath) {
    const abs = path.resolve(localPath);
    if (!(await isDirectory(abs))) throw new Error(`Not a directory: ${abs}`);
    const gitDir = await new Promise((resolve, reject) => {
      execFile('git', ['-C', abs, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }, (err, stdout) => {
        if (err) reject(new Error(`Not a git repository: ${abs}`));
        else resolve(stdout.trim());
      });
    });
    const name = path.basename(abs);
    const id = this.newId(name);
    const dir = this.repoDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const meta = {
      id,
      name,
      source: { type: 'local', detail: abs },
      gitDir,
      createdAt: new Date().toISOString(),
      status: { state: 'analyzing', progress: 0, message: 'Analyzing…' },
      info: null,
      stats: null,
      authorMerges: {},
    };
    await this.saveMeta(meta);
    this.startAnalysis(id);
    return meta;
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  startAnalysis(id) {
    if (this.analyzing.has(id)) return;
    this.analyzing.add(id);
    this.runAnalysis(id)
      .catch(() => {})
      .finally(() => this.analyzing.delete(id));
  }

  async runAnalysis(id) {
    const meta = this.get(id);
    if (!meta || !meta.gitDir) return;
    try {
      await this.setStatus(id, { state: 'analyzing', progress: 0, message: 'Reading git history…' });
      const ds = await analyzer.buildDataset(meta.gitDir, {
        onProgress: (parsed, total) => {
          const progress = total > 0 ? Math.min(parsed / total, 1) : 0;
          this.setStatus(
            id,
            { state: 'analyzing', progress, message: `Parsing commits… ${parsed}${total ? ' / ' + total : ''}` },
            { throttle: true }
          ).catch(() => {});
        },
      });
      const bytes = await analyzer.saveDataset(ds, this.datasetPath(id));
      meta.info = { head: ds.head, branch: ds.branch, headTime: ds.headTime, commitCount: ds.commits.length };
      meta.stats = { files: ds.files.length, dirs: ds.dirs.length - 1, authors: ds.authors.length };
      meta.datasetBytes = bytes;
      await this.setStatus(id, { state: 'ready', progress: 1, message: 'Ready' }, { throttle: false });
      this.cacheDataset(id, ds);
    } catch (err) {
      await this.setStatus(id, { state: 'error', progress: 0, message: err.message }, { throttle: false });
    }
  }

  async reanalyze(id) {
    const meta = this.get(id);
    if (!meta) return null;
    this.datasets.delete(id);
    if (meta.status && meta.status.state === 'ready') {
      await this.setStatus(id, { state: 'analyzing', progress: 0, message: 'Re-analyzing…' });
    }
    this.startAnalysis(id);
    return meta;
  }

  cacheDataset(id, ds) {
    if (this.datasets.has(id)) this.datasets.delete(id);
    this.datasets.set(id, ds);
    while (this.datasets.size > this.maxCached) {
      const first = this.datasets.keys().next().value;
      this.datasets.delete(first);
    }
  }

  /** Load the parsed dataset for a repo (cached). */
  async getDataset(id) {
    if (this.datasets.has(id)) {
      const ds = this.datasets.get(id);
      this.datasets.delete(id);
      this.datasets.set(id, ds);
      return ds;
    }
    const p = this.datasetPath(id);
    if (!(await pathExists(p))) return null;
    const ds = await analyzer.loadDataset(p);
    this.cacheDataset(id, ds);
    return ds;
  }

  async updateMerges(id, mutator) {
    const meta = this.get(id);
    if (!meta) return null;
    meta.authorMerges = meta.authorMerges || {};
    mutator(meta.authorMerges);
    await this.saveMeta(meta);
    return meta;
  }

  async delete(id) {
    const meta = this.get(id);
    if (!meta) return false;
    this.datasets.delete(id);
    this.metas.delete(id);
    await fsp.rm(this.repoDir(id), { recursive: true, force: true });
    return true;
  }
}

module.exports = { Store };
