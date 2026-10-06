'use strict';

/* ---------------------------------------------------------------------------
 * RAT dashboard - part 1: state, repositories, filters, metric rendering
 * ------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) {
  return nf.format(Math.round(n));
}
function fmt2(n) {
  return Number(n).toFixed(2);
}
function fmtDate(t) {
  return new Date(t * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(t) {
  return new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function toast(message, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* non-JSON error body */
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (HTTP ${res.status})`);
  return data;
}


const state = {
  repos: [],
  repo: null,
  authors: [],
  merges: {},
  filter: { mode: 'all', author: '', from: null, to: null, hashes: [] },
  obj: { kind: 'repo', path: '' },
  filterVersion: 0,
  childrenCache: new Map(), // dir path -> children rows
  expanded: new Set(['']),
  childrenRows: [],
  childrenSort: { key: '', dir: 1 },
  pollTimer: null,
  refreshSeq: 0,
  timelineChart: null,
  ownersChart: null,
  picker: { selected: new Set(), offset: 0, limit: 100, total: 0, query: '' },
};

const PALETTE = ['#4f8cff', '#7c5cff', '#3fb950', '#d29922', '#f85149', '#39c5cf', '#db61a2', '#a371f7', '#e3b341', '#56d364', '#ff7b72', '#79c0ff'];

function isReady() {
  return Boolean(state.repo && state.repo.status && state.repo.status.state === 'ready');
}

/* --------------------------- repositories -------------------------------- */

async function loadRepos() {
  const { repos } = await api('/api/repos');
  state.repos = repos;
  renderRepoSelect();
}

function renderRepoSelect() {
  const sel = $('repoSelect');
  sel.innerHTML = '';
  if (!state.repos.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No repositories';
    sel.appendChild(opt);
    return;
  }
  for (const r of state.repos) {
    const opt = document.createElement('option');
    opt.value = r.id;
    const stateTxt = r.status && r.status.state === 'ready' ? `${fmt(r.info ? r.info.commitCount : 0)} commits` : (r.status ? r.status.state : '?');
    opt.textContent = `${r.name} — ${stateTxt}`;
    sel.appendChild(opt);
  }
  if (state.repo) sel.value = state.repo.id;
}

function renderHeaderStatus() {
  const pill = $('repoStatus');
  if (!state.repo || !state.repo.status) {
    pill.classList.add('hidden');
    return;
  }
  const st = state.repo.status;
  pill.classList.remove('hidden', 'ready', 'error', 'busy');
  if (st.state === 'ready') {
    pill.classList.add('ready');
    const s = state.repo.stats || {};
    pill.textContent = `ready · ${fmt(state.repo.info ? state.repo.info.commitCount : 0)} commits · ${fmt(s.files || 0)} files · ${fmt(s.authors || 0)} authors`;
  } else if (st.state === 'error') {
    pill.classList.add('error');
    pill.textContent = `error: ${st.message}`;
  } else {
    pill.classList.add('busy');
    const pct = Math.round((st.progress || 0) * 100);
    pill.textContent = `${st.state}… ${pct}%${st.message ? ' — ' + st.message : ''}`;
  }
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.repo) return stopPolling();
    try {
      const { repo } = await api(`/api/repos/${state.repo.id}`);
      const idx = state.repos.findIndex((r) => r.id === repo.id);
      if (idx >= 0) state.repos[idx] = repo;
      else state.repos.push(repo);
      state.repo = repo;
      renderRepoSelect();
      renderHeaderStatus();
      if (repo.status.state === 'ready') {
        stopPolling();
        await onRepoReady();
      } else if (repo.status.state === 'error') {
        stopPolling();
        toast(`Analysis failed: ${repo.status.message}`);
      }
    } catch (err) {
      stopPolling();
      toast(err.message);
    }
  }, 1500);
}

async function selectRepo(id) {
  stopPolling();
  state.repo = state.repos.find((r) => r.id === id) || null;
  state.childrenCache.clear();
  state.expanded = new Set(['']);
  state.obj = { kind: 'repo', path: '' };
  state.filter = { mode: 'all', author: '', from: null, to: null, hashes: [] };
  state.filterVersion++;
  $('commitMode').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'all'));
  setCommitModeUI();
  renderRepoSelect();
  renderHeaderStatus();

  const hasRepos = state.repos.length > 0;
  $('emptyState').classList.toggle('hidden', hasRepos);
  $('repoView').classList.toggle('hidden', !state.repo);
  $('filterBar').classList.toggle('hidden', !state.repo);

  if (!state.repo) return;
  if (isReady()) await onRepoReady();
  else startPolling();
}

async function onRepoReady() {
  try {
    await loadAuthors();
    await loadDir('');
    renderTree();
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------ filters ---------------------------------- */

async function bumpFilter() {
  state.filterVersion++;
  state.childrenCache.clear();
  try {
    const dirs = ['', ...state.expanded].filter((d, i, a) => a.indexOf(d) === i);
    for (const d of dirs) await loadDir(d);
  } catch (e) {
    toast(e.message);
  }
  renderTree();
  refresh();
}

function filterParams() {
  const p = new URLSearchParams();
  const f = state.filter;
  if (f.author) p.set('author', f.author);
  if (f.mode === 'range') {
    if (f.from) p.set('from', String(f.from));
    if (f.to) p.set('to', String(f.to));
  }
  if (f.mode === 'manual' && f.hashes.length) p.set('commits', f.hashes.join(','));
  return p;
}

function setCommitModeUI() {
  const mode = state.filter.mode;
  $('rangeControls').classList.toggle('hidden', mode !== 'range');
  $('manualControls').classList.toggle('hidden', mode !== 'manual');
  $('commitMode').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('manualInfo').textContent = mode === 'manual' ? `${state.filter.hashes.length} commit${state.filter.hashes.length === 1 ? '' : 's'} selected` : '';
}

function renderAuthorSelect() {
  const sel = $('authorSelect');
  const canonical = state.authors.filter((a) => a.canonical);
  const mergedCount = new Map();
  for (const a of state.authors) {
    if (!a.canonical && a.mergedInto) mergedCount.set(a.mergedInto, (mergedCount.get(a.mergedInto) || 0) + 1);
  }
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All authors';
  sel.appendChild(all);
  canonical
    .slice()
    .sort((x, y) => y.commits - x.commits)
    .forEach((a) => {
      const opt = document.createElement('option');
      opt.value = a.key;
      const extra = mergedCount.get(a.key);
      opt.textContent = `${a.name} (${fmt(a.commits)} commits)${extra ? ` +${extra} merged` : ''}`;
      sel.appendChild(opt);
    });
  sel.value = state.filter.author || '';
  if (sel.value !== (state.filter.author || '')) {
    // previously selected author no longer exists (e.g. after a merge)
    state.filter.author = '';
    sel.value = '';
  }
}

async function loadAuthors() {
  const data = await api(`/api/repos/${state.repo.id}/authors`);
  state.authors = data.authors;
  state.merges = data.merges || {};
  renderAuthorSelect();
}

/* ------------------------------- refresh --------------------------------- */

function objLabel() {
  if (!state.repo) return '';
  if (state.obj.kind === 'repo' || state.obj.path === '') return state.repo.name;
  return state.obj.path;
}

async function refresh() {
  if (!state.repo || !isReady()) return;
  const seq = ++state.refreshSeq;
  const p = filterParams();
  p.set('kind', state.obj.kind);
  p.set('object', state.obj.path);
  p.set('series', '1');
  p.set('children', '1');
  try {
    const data = await api(`/api/repos/${state.repo.id}/metrics?${p}`);
    if (seq !== state.refreshSeq) return;
    renderSummary(data);
  } catch (err) {
    toast(err.message);
  }
}

function renderSummary(data) {
  const { summary, filter } = data;
  const descBits = [];
  if (filter.author) descBits.push('author filtered');
  if (filter.manual) descBits.push(`${filter.manual} picked`);
  else if (filter.from || filter.to) descBits.push(`${filter.from ? fmtDay(filter.from) : 'start'} → ${filter.to ? fmtDay(filter.to) : 'now'}`);
  $('commitSetInfo').textContent = `|H| = ${fmt(filter.commitSetSize)}${descBits.length ? ' · ' + descBits.join(' · ') : ' · all commits'}`;

  renderCrumbs();
  renderCards(summary);
  renderTimeline(summary.series || []);
  renderOwners(summary.authors || []);
  renderChildren(summary.children);
  renderAuthorsTable(summary.authors || []);
}

function metricCard(label, value, cls = '', hint = '') {
  return `<div class="metric-card"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div>${
    hint ? `<div class="hint">${esc(hint)}</div>` : ''
  }</div>`;
}

function renderCards(s) {
  const growthCls = s.growth > 0 ? 'pos' : s.growth < 0 ? 'neg' : '';
  const growthVal = (s.growth > 0 ? '+' : '') + fmt(s.growth);
  $('metricCards').innerHTML =
    metricCard('Added', fmt(s.added)) +
    metricCard('Removed', fmt(s.removed)) +
    metricCard('Growth', growthVal, growthCls) +
    metricCard('Churn', fmt(s.churn)) +
    metricCard('Modifications', fmt(s.modifications), '', `${fmt(s.commits)} commits in set`) +
    metricCard('Frequency η', fmt2(s.frequency)) +
    metricCard('Churn rate ρ', fmt2(s.churnRate)) +
    metricCard('Object', s.kind === 'repo' ? 'repo root' : s.kind, '', s.path || '/');
}

function renderCrumbs() {
  const crumbs = $('crumbs');
  crumbs.innerHTML = '';
  const add = (label, current, onClick) => {
    const span = document.createElement('span');
    span.className = 'crumb' + (current ? ' current' : '');
    span.textContent = label;
    if (!current) span.addEventListener('click', onClick);
    crumbs.appendChild(span);
  };
  if (!state.repo) return;
  const parts = state.obj.kind === 'file' || state.obj.kind === 'dir' ? state.obj.path.split('/') : [];
  add(`${state.repo.name} (root)`, parts.length === 0, () => setObject('repo', ''));
  let acc = '';
  parts.forEach((part, i) => {
    acc = acc ? `${acc}/${part}` : part;
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    crumbs.appendChild(sep);
    const isFile = state.obj.kind === 'file' && i === parts.length - 1;
    add(part, isFile, isFile ? null : () => setObject('dir', acc));
  });
}

function renderChildren(rows) {
  const card = $('childrenCard');
  if (!rows) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  state.childrenRows = rows;
  $('childrenTitle').textContent = `Contents of ${state.obj.kind === 'repo' ? '/' : state.obj.path}`;
  sortAndRenderChildren();
}

function sortAndRenderChildren() {
  const tbody = $('childrenTable').querySelector('tbody');
  const { key, dir } = state.childrenSort;
  let rows = state.childrenRows.slice();
  if (key) {
    rows.sort((a, b) => {
      const va = a[key];
      const vb = b[key];
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return cmp * dir;
    });
  }
  $('childrenTable').querySelectorAll('th').forEach((th) => {
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = base;
    if (th.dataset.key === key) th.textContent = base + (dir === 1 ? ' ▲' : ' ▼');
  });
  tbody.innerHTML = rows
    .map((r) => {
      const icon = r.kind === 'dir' ? '📁' : '📄';
      const active = state.obj.kind === r.kind && state.obj.path === r.path ? ' class="active"' : '';
      return `<tr data-kind="${r.kind}" data-path="${esc(r.path)}"${active}>
        <td class="name"><span class="ic">${icon}</span>${esc(r.name)}</td>
        <td class="num">${fmt(r.added)}</td>
        <td class="num">${fmt(r.removed)}</td>
        <td class="num ${r.growth > 0 ? 'growth-pos' : r.growth < 0 ? 'growth-neg' : ''}">${(r.growth > 0 ? '+' : '') + fmt(r.growth)}</td>
        <td class="num">${fmt(r.churn)}</td>
        <td class="num">${fmt(r.modifications)}</td>
        <td class="num">${fmt2(r.frequency)}</td>
        <td class="num">${fmt2(r.churnRate)}</td>
      </tr>`;
    })
    .join('');
}

function renderAuthorsTable(authors) {
  $('authorsCaption').textContent = `over ${state.obj.kind === 'repo' ? 'repository' : state.obj.path}`;
  const tbody = $('authorsTable').querySelector('tbody');
  if (!authors.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">No authors for this selection.</td></tr>';
    return;
  }
  tbody.innerHTML = authors
    .map((a, i) => {
      const color = PALETTE[i % PALETTE.length];
      const pct = (a.ownership * 100).toFixed(1);
      return `<tr title="${esc(a.key)}">
        <td>${esc(a.name)}</td>
        <td class="num">${fmt(a.commits)}</td>
        <td class="num">${fmt(a.added)}</td>
        <td class="num">${fmt(a.removed)}</td>
        <td class="num">${fmt(a.churn)}</td>
        <td class="num">${fmt(a.modifications)}</td>
        <td>
          <div class="ownership-cell">
            <div class="ownership-bar"><div style="width:${(a.ownership * 100).toFixed(2)}%;background:${color}"></div></div>
            <span class="num">${pct}%</span>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

/* -------------------------- object selection ----------------------------- */

function setObject(kind, path) {
  state.obj = { kind, path: path || '' };
  renderTree();
  refresh();
}

/* ---------------------------------------------------------------------------
 * RAT dashboard - part 2: tree explorer, search, modals, charts, wiring
 * ------------------------------------------------------------------------- */

/* ----------------------------- tree explorer ----------------------------- */

async function loadDir(dirPath) {
  if (!state.repo || !isReady()) return [];
  if (state.childrenCache.has(dirPath)) return state.childrenCache.get(dirPath);
  const p = filterParams();
  p.set('dir', dirPath);
  const { children } = await api(`/api/repos/${state.repo.id}/children?${p}`);
  state.childrenCache.set(dirPath, children);
  return children;
}

function renderTree() {
  const tree = $('tree');
  tree.innerHTML = '';
  if (!state.repo) return;
  const rootRow = document.createElement('div');
  rootRow.className = 'tree-row root' + (state.obj.kind === 'repo' ? ' active' : '');
  rootRow.innerHTML = `<span class="tw">${state.expanded.has('') ? '▾' : '▸'}</span><span class="nm">📦 ${esc(state.repo.name)}</span>`;
  rootRow.addEventListener('click', () => {
    if (state.expanded.has('')) state.expanded.delete('');
    else state.expanded.add('');
    setObject('repo', '');
  });
  tree.appendChild(rootRow);
  if (state.expanded.has('')) renderTreeDir('', 1, tree);
}

function renderTreeDir(dirPath, depth, container) {
  const rows = state.childrenCache.get(dirPath);
  if (!rows) return;
  for (const r of rows) {
    const isDir = r.kind === 'dir';
    const expanded = isDir && state.expanded.has(r.path);
    const row = document.createElement('div');
    row.className = 'tree-row' + (state.obj.kind === r.kind && state.obj.path === r.path ? ' active' : '');
    row.style.paddingLeft = 10 + depth * 14 + 'px';
    const tw = isDir ? (r.hasChildren ? (expanded ? '▾' : '▸') : '·') : '';
    row.innerHTML = `<span class="tw">${tw}</span><span class="nm">${isDir ? '📁' : '📄'} ${esc(r.name)}</span><span class="badge">${r.churn ? fmt(r.churn) : ''}</span>`;
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isDir) {
        if (!state.expanded.has(r.path)) {
          state.expanded.add(r.path);
          try {
            await loadDir(r.path);
          } catch (err) {
            toast(err.message);
          }
        } else {
          state.expanded.delete(r.path);
        }
        setObject('dir', r.path);
      } else {
        setObject('file', r.path);
      }
    });
    container.appendChild(row);
    if (isDir && expanded) renderTreeDir(r.path, depth + 1, container);
  }
}

async function expandToPath(path) {
  const parts = path.split('/');
  const dirs = [''];
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    dirs.push(acc);
  }
  for (const d of dirs) {
    state.expanded.add(d);
    try {
      await loadDir(d);
    } catch (_) {
      /* ignore */
    }
  }
  renderTree();
}

const doSearch = debounce(async () => {
  if (!state.repo || !isReady()) return;
  const q = $('objSearch').value.trim();
  const box = $('searchResults');
  if (q.length < 2) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  try {
    const { results } = await api(`/api/repos/${state.repo.id}/search?q=${encodeURIComponent(q)}`);
    box.innerHTML =
      results
        .map(
          (r) =>
            `<div class="item" data-kind="${r.kind}" data-path="${esc(r.path)}"><span class="kind">${r.kind === 'dir' ? '📁' : '📄'}</span><span>${esc(r.path)}</span></div>`
        )
        .join('') || '<div class="item muted">No matches</div>';
    box.classList.remove('hidden');
    box.querySelectorAll('.item[data-path]').forEach((el) =>
      el.addEventListener('click', async () => {
        box.classList.add('hidden');
        $('objSearch').value = '';
        await expandToPath(el.dataset.path);
        setObject(el.dataset.kind, el.dataset.path);
      })
    );
  } catch (err) {
    toast(err.message);
  }
}, 250);

/* ------------------------------- modals ---------------------------------- */

function openModal(id) {
  $(id).classList.remove('hidden');
}
function closeModal(id) {
  $(id).classList.add('hidden');
}

function resetAddModal() {
  $('addRepoProgress').classList.add('hidden');
  $('addProgressBar').style.width = '0%';
  $('addProgressText').textContent = '';
}

function updateAddProgress(repo) {
  const st = repo.status || {};
  const pct = Math.round((st.progress || 0) * 100);
  $('addProgressBar').style.width = pct + '%';
  $('addProgressText').textContent = `${st.state}… ${pct}%${st.message ? ' — ' + st.message : ''}`;
}

async function submitAdd(doPost, label) {
  const prog = $('addRepoProgress');
  prog.classList.remove('hidden');
  $('addProgressBar').style.width = '0%';
  $('addProgressText').textContent = `${label}…`;
  try {
    const result = await doPost();
    const repoId = result.repo.id;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1200));
      const { repo } = await api(`/api/repos/${repoId}`);
      updateAddProgress(repo);
      if (repo.status.state === 'ready') {
        toast(`Repository "${repo.name}" is ready`, 'success');
        break;
      }
      if (repo.status.state === 'error') {
        $('addProgressText').textContent = `Error: ${repo.status.message}`;
        toast(`Analysis failed: ${repo.status.message}`);
        break;
      }
    }
    resetAddModal();
    closeModal('modalAddRepo');
    await loadRepos();
    await selectRepo(repoId);
  } catch (err) {
    $('addProgressText').textContent = `Error: ${err.message}`;
    toast(err.message);
  }
}

/* --------------------------- commit picker -------------------------------- */

async function openCommitPicker() {
  state.picker.selected = new Set(state.filter.mode === 'manual' ? state.filter.hashes : []);
  state.picker.offset = 0;
  state.picker.query = '';
  $('pickSearch').value = '';
  openModal('modalCommits');
  await loadPickPage(false);
}

async function loadPickPage(append) {
  const p = new URLSearchParams();
  p.set('offset', String(state.picker.offset));
  p.set('limit', String(state.picker.limit));
  if (state.picker.query) p.set('q', state.picker.query);
  if (state.filter.author) p.set('author', state.filter.author);
  const data = await api(`/api/repos/${state.repo.id}/commits?${p}`);
  state.picker.total = data.total;
  state.picker.offset += data.items.length;
  const list = $('pickList');
  if (!append) list.innerHTML = '';
  const html = data.items
    .map((c) => {
      const checked = state.picker.selected.has(c.hash) ? 'checked' : '';
      return `<label class="pick-item"><input type="checkbox" ${checked} data-hash="${c.hash}"><span class="h">${esc(c.short)}</span><span class="d">${fmtDay(c.t)}</span><span class="a">${esc(c.author)}</span><span class="s">${esc(c.subject)}</span></label>`;
    })
    .join('');
  list.insertAdjacentHTML('beforeend', html || '<div class="pick-item muted">No commits match.</div>');
  $('btnPickMore').classList.toggle('hidden', state.picker.offset >= data.total);
  updatePickCount();
}

function updatePickCount() {
  $('pickCount').textContent = `${state.picker.selected.size} selected · ${fmt(state.picker.total)} matching`;
}

async function selectAllMatching() {
  const cap = 5000;
  const collected = [];
  for (let off = 0; off < Math.min(state.picker.total, cap); off += 500) {
    const p = new URLSearchParams({ offset: String(off), limit: '500' });
    if (state.picker.query) p.set('q', state.picker.query);
    if (state.filter.author) p.set('author', state.filter.author);
    const data = await api(`/api/repos/${state.repo.id}/commits?${p}`);
    collected.push(...data.items.map((c) => c.hash));
    if (!data.items.length) break;
  }
  if (state.picker.total > cap) toast(`Only the first ${cap} of ${fmt(state.picker.total)} commits were selected.`);
  for (const h of collected) state.picker.selected.add(h);
  await loadPickPage(false);
}

/* ------------------------- author merge modal ----------------------------- */

function renderMergeModal() {
  const opts = state.authors
    .map((a) => `<option value="${esc(a.key)}">${esc(a.name)} &lt;${esc(a.email)}&gt; (${fmt(a.commits)})</option>`)
    .join('');
  $('mergeSource').innerHTML = opts;
  $('mergeTarget').innerHTML = opts;
  const tbody = $('mergeTable').querySelector('tbody');
  tbody.innerHTML = state.authors
    .map((a) => {
      const merged = a.mergedInto ? `<span class="muted">→ ${esc(a.mergedInto.split(' <')[0])}</span>` : '<span class="muted">—</span>';
      const un = a.mergedInto ? `<button class="btn small ghost" data-unmerge="${esc(a.key)}">unmerge</button>` : '';
      return `<tr><td>${esc(a.name)}</td><td class="muted">${esc(a.email)}</td><td class="num">${fmt(a.commits)}</td><td>${merged}</td><td>${un}</td></tr>`;
    })
    .join('');
}

async function doMerge() {
  const source = $('mergeSource').value;
  const target = $('mergeTarget').value;
  if (!source || !target || source === target) return toast('Pick two different authors.');
  try {
    await api(`/api/repos/${state.repo.id}/authors/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, target }),
    });
    if (state.filter.author === source) state.filter.author = target;
    await loadAuthors();
    renderMergeModal();
    await bumpFilter();
  } catch (err) {
    toast(err.message);
  }
}

async function doUnmerge(source) {
  try {
    await api(`/api/repos/${state.repo.id}/authors/unmerge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    await loadAuthors();
    renderMergeModal();
    await bumpFilter();
  } catch (err) {
    toast(err.message);
  }
}

/* -------------------------------- charts ---------------------------------- */

function chartDefaults() {
  Chart.defaults.color = '#8b98a5';
  Chart.defaults.borderColor = '#2b3440';
  Chart.defaults.font.size = 11;
}

function renderTimeline(series) {
  const canvas = $('chartTimeline');
  const empty = $('timelineEmpty');
  if (state.timelineChart) {
    state.timelineChart.destroy();
    state.timelineChart = null;
  }
  if (!series.length) {
    empty.classList.remove('hidden');
    canvas.style.opacity = 0;
    return;
  }
  empty.classList.add('hidden');
  canvas.style.opacity = 1;
  const labels = series.map((p) => (series.length > 80 ? fmtDay(p[0]) : p[1]));
  const added = series.map((p) => p[2]);
  const removed = series.map((p) => -p[3]);
  let acc = 0;
  const growth = series.map((p) => (acc += p[2] - p[3]));
  state.timelineChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Removed', data: removed, backgroundColor: 'rgba(248,81,73,0.55)', stack: 'churn' },
        { label: 'Added', data: added, backgroundColor: 'rgba(63,185,80,0.55)', stack: 'churn' },
        { type: 'line', label: 'Cumulative growth', data: growth, borderColor: '#4f8cff', backgroundColor: '#4f8cff', pointRadius: 0, borderWidth: 2, tension: 0.15 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 14 }, grid: { display: false } },
        y: { stacked: true, grid: { color: '#222b36' } },
      },
      plugins: {
        legend: { labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y > 0 ? '+' : ''}${fmt(ctx.parsed.y)}` } },
      },
    },
  });
}

function renderOwners(authors) {
  const canvas = $('chartOwners');
  const empty = $('ownersEmpty');
  if (state.ownersChart) {
    state.ownersChart.destroy();
    state.ownersChart = null;
  }
  const rows = authors.filter((a) => a.ownership > 0).slice(0, 12);
  if (!rows.length) {
    empty.classList.remove('hidden');
    canvas.style.opacity = 0;
    return;
  }
  empty.classList.add('hidden');
  canvas.style.opacity = 1;
  const labels = rows.map((a) => a.name).reverse();
  const values = rows.map((a) => +(a.ownership * 100).toFixed(2)).reverse();
  const colors = rows.map((_, i) => PALETTE[i % PALETTE.length]).reverse();
  state.ownersChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Ownership', data: values, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { max: 100, grid: { color: '#222b36' }, ticks: { callback: (v) => v + '%' } },
        y: { grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x}% of churn` } },
      },
    },
  });
}

/* ------------------------------- wiring ----------------------------------- */

function initEvents() {
  $('repoSelect').addEventListener('change', (e) => selectRepo(e.target.value));

  $('btnAddRepo').addEventListener('click', () => {
    resetAddModal();
    openModal('modalAddRepo');
  });

  $('btnDeleteRepo').addEventListener('click', async () => {
    if (!state.repo) return;
    if (!confirm(`Remove "${state.repo.name}" from RAT? (The original repository is not affected.)`)) return;
    try {
      await api(`/api/repos/${state.repo.id}`, { method: 'DELETE' });
      toast('Repository removed', 'success');
      state.repo = null;
      await loadRepos();
      await selectRepo(state.repos.length ? state.repos[0].id : '');
    } catch (err) {
      toast(err.message);
    }
  });

  $('btnReanalyze').addEventListener('click', async () => {
    if (!state.repo) return;
    try {
      await api(`/api/repos/${state.repo.id}/reanalyze`, { method: 'POST' });
      toast('Re-analysis started');
      renderHeaderStatus();
      startPolling();
    } catch (err) {
      toast(err.message);
    }
  });

  $('authorSelect').addEventListener('change', (e) => {
    state.filter.author = e.target.value;
    state.picker.selected = new Set();
    bumpFilter();
  });

  $('btnMergeAuthors').addEventListener('click', () => {
    renderMergeModal();
    openModal('modalMerge');
  });

  $('commitMode').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'all') {
      state.filter.mode = 'all';
      state.filter.hashes = [];
      state.filter.from = null;
      state.filter.to = null;
      setCommitModeUI();
      bumpFilter();
    } else if (mode === 'range') {
      state.filter.mode = 'range';
      setCommitModeUI();
    } else {
      openCommitPicker();
    }
  });

  $('btnApplyRange').addEventListener('click', () => {
    const from = $('fromInput').value ? Math.floor(new Date($('fromInput').value).getTime() / 1000) : null;
    const to = $('toInput').value ? Math.floor(new Date($('toInput').value).getTime() / 1000) : null;
    if (from == null && to == null) return toast('Pick a start and/or end date first.');
    state.filter.mode = 'range';
    state.filter.from = from;
    state.filter.to = to;
    state.filter.hashes = [];
    setCommitModeUI();
    bumpFilter();
  });

  document.querySelectorAll('[data-last]').forEach((b) =>
    b.addEventListener('click', () => {
      const days = parseInt(b.dataset.last, 10);
      state.filter.mode = 'range';
      state.filter.from = Math.floor(Date.now() / 1000) - days * 86400;
      state.filter.to = null;
      state.filter.hashes = [];
      setCommitModeUI();
      bumpFilter();
    })
  );

  $('btnEditManual').addEventListener('click', () => openCommitPicker());
  $('btnClearManual').addEventListener('click', () => {
    state.filter.mode = 'all';
    state.filter.hashes = [];
    setCommitModeUI();
    bumpFilter();
  });

  $('objSearch').addEventListener('input', doSearch);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) $('searchResults').classList.add('hidden');
  });

  $('childrenTable').querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    const key = th.dataset.key;
    if (state.childrenSort.key === key) state.childrenSort.dir *= -1;
    else state.childrenSort = { key, dir: key === 'name' ? 1 : -1 };
    sortAndRenderChildren();
  });

  $('childrenTable').querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-path]');
    if (!tr) return;
    setObject(tr.dataset.kind, tr.dataset.path);
  });

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  document.querySelectorAll('.modal-backdrop').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden');
    })
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
  });

  $('addRepoTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('#addRepoTabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#modalAddRepo .tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab));
  });

  $('btnClone').addEventListener('click', () => {
    const url = $('cloneUrl').value.trim();
    if (!url) return toast('Enter a repository URL.');
    const name = $('cloneName').value.trim() || undefined;
    submitAdd(
      () => api('/api/repos/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, name }) }),
      'Cloning repository'
    );
  });

  $('btnLocal').addEventListener('click', () => {
    const p = $('localPath').value.trim();
    if (!p) return toast('Enter a local repository path.');
    submitAdd(
      () => api('/api/repos/local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) }),
      'Analyzing local repository'
    );
  });

  $('btnPickZip').addEventListener('click', () => $('zipFile').click());
  $('zipFile').addEventListener('change', () => {
    state.zipFileChosen = $('zipFile').files[0] || null;
    $('zipChosen').textContent = state.zipFileChosen ? state.zipFileChosen.name : '';
  });
  const dz = $('dropZone');
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) {
      state.zipFileChosen = f;
      $('zipChosen').textContent = f.name;
    }
  });
  $('btnUploadZip').addEventListener('click', () => {
    const file = state.zipFileChosen || ($('zipFile').files && $('zipFile').files[0]);
    if (!file) return toast('Choose a zip file first.');
    const fd = new FormData();
    fd.append('file', file);
    const name = $('zipName').value.trim();
    if (name) fd.append('name', name);
    submitAdd(() => api('/api/repos/upload', { method: 'POST', body: fd }), 'Uploading zip');
  });

  $('pickSearch').addEventListener(
    'input',
    debounce(() => {
      state.picker.query = $('pickSearch').value.trim();
      state.picker.offset = 0;
      loadPickPage(false).catch((e) => toast(e.message));
    }, 250)
  );
  $('btnPickMore').addEventListener('click', () => loadPickPage(true).catch((e) => toast(e.message)));
  $('btnPickAll').addEventListener('click', () => selectAllMatching().catch((e) => toast(e.message)));
  $('btnPickNone').addEventListener('click', () => {
    state.picker.selected.clear();
    $('pickList')
      .querySelectorAll('input[type=checkbox]')
      .forEach((cb) => (cb.checked = false));
    updatePickCount();
  });
  $('pickList').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.checked) state.picker.selected.add(cb.dataset.hash);
    else state.picker.selected.delete(cb.dataset.hash);
    updatePickCount();
  });
  $('btnPickApply').addEventListener('click', () => {
    if (!state.picker.selected.size) return toast('Select at least one commit.');
    state.filter.mode = 'manual';
    state.filter.hashes = [...state.picker.selected];
    state.filter.from = null;
    state.filter.to = null;
    setCommitModeUI();
    bumpFilter();
    closeModal('modalCommits');
  });

  $('btnDoMerge').addEventListener('click', () => doMerge());
  $('mergeTable').querySelector('tbody').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-unmerge]');
    if (b) doUnmerge(b.dataset.unmerge);
  });
}

async function main() {
  chartDefaults();
  initEvents();
  try {
    await loadRepos();
    if (state.repos.length) {
      await selectRepo(state.repos[0].id);
    } else {
      $('emptyState').classList.remove('hidden');
      $('filterBar').classList.add('hidden');
      $('repoView').classList.add('hidden');
    }
  } catch (err) {
    toast(err.message);
  }
}

main();
