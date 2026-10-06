'use strict';
/**
 * Cross-validate the metrics engine against a reference CSV dump.
 *
 * Usage: node test/compare-reference.js <repoId> <reference.csv>
 *   e.g. node test/compare-reference.js git-git-19ee39 /path/to/git_<sha>.csv
 *
 * Every row of the CSV is recomputed through the production engine
 * (server/metrics.js, no manual merges) and compared field by field.
 * Exit code 0 only when everything matches.
 */
const fs = require('fs');
const path = require('path');
const { loadDataset } = require('../server/analyzer');
const { resolveAuthorMerges, selectCommits, computeMetrics, resolveObject } = require('../server/metrics');

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const relClose = (got, want) => Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));

async function main() {
  const [repoId, csvPath] = process.argv.slice(2);
  if (!repoId || !csvPath) {
    console.error('usage: node test/compare-reference.js <repoId> <reference.csv>');
    process.exit(2);
  }
  const ds = await loadDataset(path.join(__dirname, '..', 'data', 'repos', repoId, 'dataset.json.gz'));
  const canArr = resolveAuthorMerges(ds, {});
  const { sel, n } = selectCommits(ds, {});

  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0]);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const objects = new Map();
  let refCommitCount = null;
  for (let i = 1; i < lines.length; i++) {
    const r = splitCsvLine(lines[i]);
    if (refCommitCount === null) refCommitCount = Number(r[col.commit_count]);
    const kind = r[col.object_type] === 'repository' ? 'repo' : r[col.object_type] === 'directory' ? 'dir' : 'file';
    const p = kind === 'repo' ? '' : r[col.path];
    const key = `${kind}|${p}`;
    let o = objects.get(key);
    if (!o) { o = { kind, path: p, rows: [] }; objects.set(key, o); }
    o.rows.push(r);
  }

  const problems = [];
  const missingObjects = [];
  const missingAuthors = [];
  let rowsChecked = 0;
  let fieldsChecked = 0;
  let processed = 0;

  for (const o of objects.values()) {
    processed++;
    if (processed % 2000 === 0) process.stderr.write(`  ... ${processed}/${objects.size} objects\n`);
    const obj = resolveObject(ds, o.kind, o.path);
    if (!obj) { missingObjects.push(`${o.kind} ${o.path || '/'}`); continue; }
    const m = computeMetrics(ds, { sel, n, obj, canArr });
    const byKey = new Map(m.authors.map((a) => [a.key, a]));
    const label = `${o.kind} ${o.path || '/'}`;

    for (const r of o.rows) {
      rowsChecked++;
      const author = r[col.author];
      const num = (name) => {
        const raw = r[col[name]];
        if (raw === '' || raw === undefined) return null;
        const v = Number(raw);
        return Number.isFinite(v) ? v : null; // 'NaN' etc. -> no constraint
      };
      const check = (name, got) => {
        const want = num(name);
        if (want === null) return;
        fieldsChecked++;
        if (!relClose(got, want)) {
          problems.push(`${label} [${author}] ${name}: got ${got} want ${want}`);
        }
      };
      const cc = num('commit_count');
      if (cc !== null && cc !== n) problems.push(`${label} commit_count: got ${n} want ${cc}`);

      if (author === 'ALL') {
        check('added', m.added);
        check('removed', m.removed);
        check('growth', m.growth);
        check('churn', m.churn);
        check('modifications', m.modifications);
        check('modification_frequency', m.frequency);
        check('churn_rate', m.churnRate);
      } else {
        const a = byKey.get(author);
        if (!a) { missingAuthors.push(`${label} :: ${author}`); continue; }
        check('added', a.added);
        check('removed', a.removed);
        check('growth', a.added - a.removed);
        check('churn', a.churn);
        check('modifications', a.modifications);
        check('ownership', a.ownership);
      }
    }
  }

  // Objects we know that the reference does not list.
  const csvKeys = new Set(objects.keys());
  const extra = [];
  if (!csvKeys.has('repo|')) extra.push('repo /');
  for (let d = 1; d < ds.dirs.length; d++) if (!csvKeys.has(`dir|${ds.dirs[d]}`)) extra.push(`dir ${ds.dirs[d]}`);
  for (const f of ds.files) if (!csvKeys.has(`file|${f}`)) extra.push(`file ${f}`);

  const report = (title, arr, cap = 25) => {
    console.log(`${title}: ${arr.length}`);
    arr.slice(0, cap).forEach((x) => console.log(`   - ${x}`));
    if (arr.length > cap) console.log(`   ... and ${arr.length - cap} more`);
  };
  console.log(`\n== ${path.basename(csvPath)} vs ${repoId} ==`);
  console.log(`commit set |H| = ${n}, reference commit_count = ${refCommitCount}, equal: ${n === refCommitCount}`);
  console.log(`reference objects: ${objects.size}, our objects: ${ds.dirs.length + ds.files.length} (dirs incl. root + files)`);
  console.log(`rows checked: ${rowsChecked}, fields checked: ${fieldsChecked}`);
  report('FIELD MISMATCHES', problems);
  report('REFERENCE OBJECTS MISSING FROM OUR DATASET', missingObjects);
  report('REFERENCE AUTHOR ROWS WITHOUT MATCHING AUTHOR', missingAuthors);
  report('OUR OBJECTS NOT IN REFERENCE', extra);

  const fail = problems.length + missingObjects.length + missingAuthors.length + extra.length + (n === refCommitCount ? 0 : 1);
  console.log(fail === 0 ? '\nALL MATCH' : `\nFAILED: ${fail} issue(s)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
