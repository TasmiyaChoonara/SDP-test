'use strict';

/**
 * run-tests.js
 *
 * End-to-end verification of the metric engine against a controlled fixture
 * repository (see make-fixture.sh) whose expected metrics are computed by
 * hand from the definitions in the test brief.
 *
 * Run with: npm test
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const analyzer = require('../server/analyzer');
const metrics = require('../server/metrics');

const FIXTURE = path.join(__dirname, 'fixtures', 'tiny');

let checks = 0;
let failures = 0;

function eq(label, actual, expected) {
  checks++;
  const ok =
    typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected) < 1e-9
      : actual === expected;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ts(iso) {
  return Date.parse(iso) / 1000;
}

/**
 * Second fixture with directories nested three levels deep. The main fixture
 * only has 1-level dirs, which cannot catch depth/ancestor regressions (a
 * child dir discovered before its parent used to get the wrong depth, making
 * every roll-up metric come out as zero).
 */
function makeNestedFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'deep', 'nested', 'dir'), { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main', '.']);
  git(['config', 'user.name', 'Nested']);
  git(['config', 'user.email', 'nested@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  const file = path.join(dir, 'deep', 'nested', 'dir', 'file.txt');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'N1: create deep file']);
  fs.writeFileSync(file, 'one\nTWO\nthree\nfour\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'N2: edit deep file']);
  return path.join(dir, '.git');
}

async function main() {
  console.log('Creating fixture repository…');
  execFileSync('bash', [path.join(__dirname, 'make-fixture.sh'), FIXTURE], { stdio: 'pipe' });

  console.log('Building dataset…');
  const ds = await analyzer.buildDataset(path.join(FIXTURE, '.git'));
  const canArr = metrics.resolveAuthorMerges(ds, {});
  const all = metrics.selectCommits(ds, {});

  const rootObj = metrics.resolveObject(ds, 'repo', '');
  const dirObj = metrics.resolveObject(ds, 'dir', 'dir');
  const aTxt = metrics.resolveObject(ds, 'file', 'a.txt');
  const bTxt = metrics.resolveObject(ds, 'file', 'dir/b.txt');
  const cTxt = metrics.resolveObject(ds, 'file', 'dir/c.txt');
  const mailmap = metrics.resolveObject(ds, 'file', '.mailmap');

  console.log('\n[dataset structure]');
  eq('commit count (non-merge)', ds.commits.length, 5);
  eq('author count (mailmap merged)', ds.authors.length, 2);
  eq(
    'authors are Alice and Bob',
    ds.authors.map((a) => a.key).sort().join(';'),
    'Alice <alice@example.com>;Bob <bob@example.com>'
  );
  eq('binary file bin.dat is not measured', ds.files.includes('bin.dat'), false);
  eq('files tracked', ds.files.slice().sort().join(','), '.mailmap,a.txt,dir/b.txt,dir/c.txt');
  eq('root resolved', Boolean(rootObj), true);
  eq('dir resolved', Boolean(dirObj), true);

  console.log('\n[repository metrics - all commits H]');
  const rootAll = metrics.computeMetrics(ds, { sel: all.sel, n: all.n, obj: rootObj, canArr, withChildren: true, withSeries: true });
  eq('|H|', rootAll.commits, 5);
  eq('added lines l+', rootAll.added, 10);
  eq('removed lines l-', rootAll.removed, 3);
  eq('growth', rootAll.growth, 7);
  eq('churn', rootAll.churn, 13);
  eq('modifications (pure rename commit excluded)', rootAll.modifications, 4);
  eq('modification frequency', rootAll.frequency, 0.8);
  eq('churn rate', rootAll.churnRate, 2.6);

  console.log('\n[file metrics - all commits H]');
  const fA = metrics.computeMetrics(ds, { sel: all.sel, n: all.n, obj: aTxt, canArr });
  eq('a.txt added', fA.added, 7);
  eq('a.txt removed', fA.removed, 1);
  eq('a.txt growth', fA.growth, 6);
  eq('a.txt churn', fA.churn, 8);
  eq('a.txt modifications', fA.modifications, 3);
  eq('a.txt frequency', fA.frequency, 0.6);
  eq('a.txt churn rate', fA.churnRate, 1.6);

  const fB = metrics.computeMetrics(ds, { sel: all.sel, n: all.n, obj: bTxt, canArr });
  eq('dir/b.txt added (attributed while it existed)', fB.added, 2);
  eq('dir/b.txt removed', fB.removed, 0);
  eq('dir/b.txt modifications', fB.modifications, 1);

  const fC = metrics.computeMetrics(ds, { sel: all.sel, n: all.n, obj: cTxt, canArr });
  eq('dir/c.txt added (pure rename contributes 0)', fC.added, 0);
  eq('dir/c.txt removed (deletion attributed to new path)', fC.removed, 2);
  eq('dir/c.txt modifications (rename + separate delete counts once)', fC.modifications, 1);

  const fM = metrics.computeMetrics(ds, { sel: all.sel, n: all.n, obj: mailmap, canArr });
  eq('.mailmap added', fM.added, 1);
  eq('.mailmap churn', fM.churn, 1);

  console.log('\n[directory metrics - all commits H]');
  const dDir = metrics.computeMetrics(ds, { sel: all.sel, n: all.n, obj: dirObj, canArr, withChildren: false });
  eq('dir added (b.txt creation + rename + delete roll-up)', dDir.added, 2);
  eq('dir removed', dDir.removed, 2);
  eq('dir growth', dDir.growth, 0);
  eq('dir churn', dDir.churn, 4);
  eq('dir modifications', dDir.modifications, 2);
  eq('dir frequency', dDir.frequency, 0.4);
  eq('dir churn rate', dDir.churnRate, 0.8);

  console.log('\n[children of root]');
  const kids = rootAll.children;
  eq('child count (1 dir + 2 files; binary bin.dat excluded)', kids.length, 3);
  const kdir = kids.find((c) => c.kind === 'dir' && c.path === 'dir');
  const ka = kids.find((c) => c.kind === 'file' && c.path === 'a.txt');
  const kmail = kids.find((c) => c.kind === 'file' && c.path === '.mailmap');
  eq('child dir "dir" churn', kdir.churn, 4);
  eq('child dir "dir" modifications', kdir.modifications, 2);
  eq('child file a.txt churn', ka.churn, 8);
  eq('child file .mailmap churn', kmail.churn, 1);
  eq('bin.dat not a child', kids.some((c) => c.path === 'bin.dat'), false);

  console.log('\n[commit set H_i,j - commits in [B, D)]');
  const rangeBD = metrics.selectCommits(ds, { from: ts('2024-01-02T00:00:00Z'), to: ts('2024-01-04T00:00:00Z') });
  eq('|H| = 2 (B and C)', rangeBD.n, 2);
  const rBD = metrics.computeMetrics(ds, { sel: rangeBD.sel, n: rangeBD.n, obj: rootObj, canArr, withChildren: false });
  eq('added', rBD.added, 5);
  eq('removed', rBD.removed, 1);
  eq('churn', rBD.churn, 6);
  eq('modifications (rename commit has lambda=0)', rBD.modifications, 1);
  eq('frequency', rBD.frequency, 0.5);
  eq('churn rate', rBD.churnRate, 3);

  console.log('\n[commit set H_t - commits from D to present]');
  const rangeD = metrics.selectCommits(ds, { from: ts('2024-01-04T00:00:00Z') });
  eq('|H| = 2 (D and E)', rangeD.n, 2);
  const rD = metrics.computeMetrics(ds, { sel: rangeD.sel, n: rangeD.n, obj: rootObj, canArr, withChildren: false });
  eq('added', rD.added, 1);
  eq('removed', rD.removed, 2);
  eq('growth (negative)', rD.growth, -1);
  eq('churn', rD.churn, 3);
  eq('modifications', rD.modifications, 2);
  eq('frequency', rD.frequency, 1);
  eq('churn rate', rD.churnRate, 1.5);

  console.log('\n[manual commit selection {A, B}]');
  const hashesAB = [ds.commits[4].h, ds.commits[3].h]; // A and B are the two oldest
  const manual = metrics.selectCommits(ds, { hashes: hashesAB });
  eq('|H| = 2', manual.n, 2);
  const rAB = metrics.computeMetrics(ds, { sel: manual.sel, n: manual.n, obj: rootObj, canArr, withChildren: false });
  eq('added', rAB.added, 9);
  eq('removed', rAB.removed, 1);
  eq('churn', rAB.churn, 10);
  eq('frequency', rAB.frequency, 1);
  eq('churn rate', rAB.churnRate, 5);

  console.log('\n[author metrics]');
  const alice = rootAll.authors.find((a) => a.name === 'Alice');
  const bob = rootAll.authors.find((a) => a.name === 'Bob');
  eq('Alice churn', alice.churn, 7);
  eq('Alice modifications', alice.modifications, 3);
  eq('Alice commits in H', alice.commits, 3);
  eq('Alice ownership', alice.ownership, 7 / 13);
  eq('Bob churn', bob.churn, 6);
  eq('Bob modifications', bob.modifications, 1);
  eq('Bob commits in H', bob.commits, 2);
  eq('Bob ownership', bob.ownership, 6 / 13);

  const aAuth = fA.authors.filter((a) => a.churn > 0);
  const aliceA = aAuth.find((a) => a.name === 'Alice');
  const bobA = aAuth.find((a) => a.name === 'Bob');
  eq('a.txt Alice churn', aliceA.churn, 4);
  eq('a.txt Alice modifications', aliceA.modifications, 2);
  eq('a.txt Bob churn', bobA.churn, 4);
  eq('a.txt ownership split', aliceA.ownership + bobA.ownership, 1);

  const dAuth = dDir.authors.filter((a) => a.churn > 0);
  eq('dir author count', dAuth.length, 2);
  eq('dir Alice ownership', dAuth.find((a) => a.name === 'Alice').ownership, 0.5);

  console.log('\n[author filtering with merged authors]');
  const aliceIdx = ds.authorIndex.get('Alice <alice@example.com>');
  const aliceOnly = metrics.selectCommits(ds, { authorIds: new Set([aliceIdx]) });
  eq('|H| = Alice commits only', aliceOnly.n, 3);
  const rAlice = metrics.computeMetrics(ds, { sel: aliceOnly.sel, n: aliceOnly.n, obj: rootObj, canArr, withChildren: false });
  eq('Alice-only churn on root', rAlice.churn, 7);
  eq('Alice-only ownership = 1', rAlice.authors[0].ownership, 1);

  console.log('\n[manual author merging]');
  const merged2 = metrics.resolveAuthorMerges(ds, { 'Bob <bob@example.com>': 'Alice <alice@example.com>' });
  const authors2 = metrics.listAuthors(ds, merged2);
  const bobRow = authors2.find((a) => a.name === 'Bob');
  eq('Bob merged into Alice', bobRow.mergedInto, 'Alice <alice@example.com>');
  const selA = metrics.selectCommits(ds, { authorIds: new Set([aliceIdx, ds.authorIndex.get('Bob <bob@example.com>')]) });
  const rMerged = metrics.computeMetrics(ds, { sel: selA.sel, n: selA.n, obj: rootObj, canArr: merged2, withChildren: false });
  eq('merged churn = 13', rMerged.churn, 13);
  eq('merged single author row', rMerged.authors[0].ownership, 1);

  console.log('\n[commit listing and search]');
  const list = metrics.listCommits(ds, canArr, { limit: 10 });
  eq('total commits', list.total, 5);
  eq('most recent commit subject', list.items[0].subject, 'E: binary + edit');
  const search = metrics.searchPaths(ds, 'c.txt');
  eq('search finds dir/c.txt', search.some((r) => r.path === 'dir/c.txt'), true);

  console.log('\n[series]');
  eq('series points (zero-churn commit excluded)', rootAll.series.length, 4);
  const seriesAdd = rootAll.series.reduce((s, p) => s + p[2], 0);
  const seriesDel = rootAll.series.reduce((s, p) => s + p[3], 0);
  eq('series total added', seriesAdd, 10);
  eq('series total removed', seriesDel, 3);

  console.log('\n[nested directories (3 levels) - regression]');
  const nestedGit = makeNestedFixture(path.join(__dirname, 'fixtures', 'nested'));
  const nds = await analyzer.buildDataset(nestedGit);
  const nCan = metrics.resolveAuthorMerges(nds, {});
  const nAll = metrics.selectCommits(nds, {});
  const dirId = (p) => nds.dirs.indexOf(p);
  eq('dir "deep" resolved', dirId('deep') > 0, true);
  eq('dir "deep/nested" resolved', dirId('deep/nested') > 0, true);
  eq('dir "deep/nested/dir" resolved', dirId('deep/nested/dir') > 0, true);
  eq('depth of "deep"', nds.dirDepth[dirId('deep')], 1);
  eq('depth of "deep/nested"', nds.dirDepth[dirId('deep/nested')], 2);
  eq('depth of "deep/nested/dir"', nds.dirDepth[dirId('deep/nested/dir')], 3);
  eq('parent of "deep/nested/dir"', nds.dirParent[dirId('deep/nested/dir')], dirId('deep/nested'));

  // N1: +3 -0, N2: +2 -1 -> added 5, removed 1, churn 6, both commits modify.
  const nDeepDir = metrics.computeMetrics(nds, { sel: nAll.sel, n: nAll.n, obj: metrics.resolveObject(nds, 'dir', 'deep/nested/dir'), canArr: nCan });
  eq('deep/nested/dir added', nDeepDir.added, 5);
  eq('deep/nested/dir removed', nDeepDir.removed, 1);
  eq('deep/nested/dir growth', nDeepDir.growth, 4);
  eq('deep/nested/dir churn', nDeepDir.churn, 6);
  eq('deep/nested/dir modifications', nDeepDir.modifications, 2);
  eq('deep/nested/dir frequency', nDeepDir.frequency, 1);
  eq('deep/nested/dir churn rate', nDeepDir.churnRate, 3);

  const nMid = metrics.computeMetrics(nds, { sel: nAll.sel, n: nAll.n, obj: metrics.resolveObject(nds, 'dir', 'deep/nested'), canArr: nCan });
  eq('deep/nested roll-up churn', nMid.churn, 6);
  eq('deep/nested roll-up modifications', nMid.modifications, 2);

  const nTop = metrics.computeMetrics(nds, { sel: nAll.sel, n: nAll.n, obj: metrics.resolveObject(nds, 'dir', 'deep'), canArr: nCan });
  eq('deep roll-up churn', nTop.churn, 6);

  const nRoot = metrics.computeMetrics(nds, { sel: nAll.sel, n: nAll.n, obj: metrics.resolveObject(nds, 'repo', ''), canArr: nCan, withChildren: true });
  eq('nested root churn', nRoot.churn, 6);
  eq('nested root children = top-level dir only', nRoot.children.length, 1);
  eq('nested root child is "deep"', nRoot.children[0].kind + ' ' + nRoot.children[0].path, 'dir deep');
  eq('nested root child churn', nRoot.children[0].churn, 6);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} FAILURES`);
    process.exit(1);
  }
  console.log('All tests passed.');
}

main().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
