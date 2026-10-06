# RAT — Repository Analysis Tool

**COMS3011A Test submission** — a web-app dashboard that measures git repository
metrics across **files, directories, the repository as a whole, arbitrary commit
sets and authors**.

RAT analyzes multiple repositories, accepts repositories as a **zip of the repo
(with `.git`)** or a **remote URL that is deeply cloned**, merges authors via
`.mailmap` or manually, and lets you filter everything by repository, author,
file/directory and commit set.

---

## Quick start

```bash
./start.sh
```

or manually:

```bash
npm install
npm start
```

Then open **http://localhost:3000** in a browser.

### Requirements

- **Node.js ≥ 18** (tested on Node 18.19)
- **git** available on `PATH` (the analysis engine shells out to git)
- No database, no build step, no internet connection required at runtime
  (except when cloning a remote repository)

---

## Using the dashboard

1. **Add a repository** — click *"+ Add repository"*:
   - **Clone URL** — e.g. `https://github.com/DaveGamble/cJSON.git` (deep clone)
   - **Zip upload** — a zip of a repository *including its `.git` directory*
     (drag & drop or browse)
   - **Local path** — a repository already on the machine
2. Watch the status pill (cloning → analyzing → ready; progress is shown).
3. **Drill down** using the object tree (left sidebar), the search box, or the
   *Contents* table — the breadcrumbs show where you are. Click any directory
   or file to see its metrics.
4. **Filter** using the filter bar:
   - **Author** (works across merged authors)
   - **Commits** — `All`, a `Range` (from/to date pickers or 7d/30d/90d quick
     buttons; *from* is inclusive, *to* is exclusive), or `Pick…` to manually
     select an arbitrary list of commits (searchable, with *select all
     matching*)
5. **Merge authors** — *"Merge…"* next to the author filter. Authors sharing an
   email are merged automatically through the repository's `.mailmap`
   (git's `%aN/%aE` mailmap resolution); different emails can be merged
   manually and un-merged again.
6. **Re-analyze** (⟳) refreshes a repository from its git source; **🗑** removes
   it from RAT (the original repository is untouched).

### What the panels show

- **Metric cards** — added lines, removed lines, growth, churn, modifications,
  modification frequency η, churn rate ρ and the size of the commit set `|H|`.
- **Metric history** — per-commit added/removed bars plus a cumulative growth
  line for the selected object and commit set.
- **Ownership** — each author's share of churn `ω` on the selected object.
- **Contents** — sortable metrics for every immediate child directory/file of
  the selected object.
- **Authors** — commits in `H`, added/removed lines, churn, author
  modifications and ownership fraction per (merged) author.

---

## Metrics implemented (per the brief)

The commit set `H` is any subset of `H̄` — the non-merge commits reachable from
HEAD — optionally restricted by date range (`H_{i,j}`, `H_t`) or by an explicit
list of commit hashes.

| Category | Metrics |
|---|---|
| **File** | added lines `l+`, removed lines `l-`, growth `δ = l+ − l-`, churn `λ = l+ + l-` |
| **Directory** | recursive roll-up over immediate child files and subdirectories |
| **Repository** | directory metrics on the root |
| **Commit set** | sums over `h ∈ H` for any object, modifications `n_{H,o}`, modification frequency `η = n_{H,o}/|H|`, churn rate `ρ = λ_{H,o}/|H|` |
| **Author** | author modifications `n_{H,o,a}`, author churn `λ_{H,o,a}`, ownership `ω = λ_{H,o,a}/λ_{H,o}` |

Semantics handled exactly as specified:

- **Non-merge commits only**; the root commit diffs against the empty tree.
- **Rename detection at 50% similarity** (`git log -M50%`): a pure rename
  contributes nothing to any metric; changes made *while* renaming are
  attributed to the **new path**.
- **Deletions** are recorded as removed lines on the (old) path.
- **Binary files are not measured** (git's own binary detection via numstat).
- **Authors are mailmap-resolved** automatically, and can additionally be
  merged manually in the UI.

## How it works

```
server/analyzer.js   single `git log --no-merges --numstat -M50%` pass over the
                     repository → compact dataset (commits, authors, files,
                     dirs, per-commit line changes), cached to disk gzipped
server/metrics.js    query engine: commit-set selection + metric computation
                     (file/dir/repo/commit-set/author, ownership, series)
server/store.js      repository ingestion (zip / clone / local), status
                     tracking, LRU dataset cache
server/index.js      Express API + static UI
public/              dashboard (vanilla JS + Chart.js)
test/                fixture generator + 90-assertion metric test suite
```

One git pass per repository keeps ingestion fast (cJSON: 955 commits in ~2 s,
queries ~10 ms); metric queries are linear in the number of recorded line
changes, so filtering a ~100 000-commit repository stays interactive.

### API (used by the UI)

```
GET    /api/repos                       list repositories (with status)
POST   /api/repos/clone                 { url }            deep clone
POST   /api/repos/upload                multipart zip        zip ingestion
POST   /api/repos/local                 { path }           local repo
GET    /api/repos/:id                   status + metadata
DELETE /api/repos/:id                   remove
POST   /api/repos/:id/reanalyze         re-run analysis
GET    /api/repos/:id/authors           authors + merges
POST   /api/repos/:id/authors/merge     { source, target }
POST   /api/repos/:id/authors/unmerge   { source }
GET    /api/repos/:id/commits           paginated/searchable commit list
GET    /api/repos/:id/search            path search
GET    /api/repos/:id/metrics           ?kind=repo|dir|file&object=…&author=…&from=…&to=…&commits=h1,h2&series=1
GET    /api/repos/:id/children          metrics for immediate children of a dir
```

Runtime data (clones, extracted zips, parsed datasets) lives in `data/` and is
git-ignored.

---

## Tests

```bash
npm test
```

This builds a controlled fixture repository (`test/make-fixture.sh`) and verifies
**90 hand-computed assertions**: mailmap auto-merging, binary exclusion, pure
renames, deletions, directory roll-ups, `H_t` / `H_{i,j}` / manual commit sets,
author churn/ownership, manual author merging, search and series.

---

## AI declaration

Developed with assistance from **Qoder** (agentic coding IDE), the AI tooling
explicitly permitted for this test.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `EADDRINUSE` port 3000 busy | `PORT=3001 npm start` |
| Zip rejected: *no `.git` found* | Re-create the zip so it includes the hidden `.git` folder (e.g. `zip -r repo.zip repo`) |
| Clone fails | Check the URL is public and reachable; `https://…git` URLs work best |
| Large repository analysis seems slow | It is a one-time pass; progress is shown in the status pill and the dataset is cached for later runs |
