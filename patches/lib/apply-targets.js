// The one patch engine. Every patches/patch-*.js only declares TARGETS and calls run().
// A target: { name, file, from, to } or { name, file, alts: [{ from, to }, ...] }, plus
// optional `marker` (proof the target is applied when a later patch edits the `to` text),
// `optional` (reason; skipped instead of failing when no `from` matches) and `ladder` (one label per alts entry,
// 'fresh' or 'fresh+<other patch>' for a bundle no Fane version has touched, 'V1', 'V2' ... for an earlier Fane
// version: it names the known versions in a "found 0" error and tells `upgraded` from `applied`).
// Contract: check every target first and change nothing on any mismatch (exit 1); never
// write a bundle that does not parse; keep a .bak of each original; re-running is a no-op.
const fs = require('fs');
const vm = require('vm');

// Without carriage returns: patches inject function source text (LANG, LABEL_ICONS, CHIP), which keeps the line
// endings of the checkout, and a CRLF checkout (Windows with core.autocrlf, the Compose mount) then wrote a `to` that
// an LF run did not recognise, so the target was applied a second time. Vane's bundles have no \r.
const lf = (s) => (typeof s === 'string' ? s.replace(/\r/g, '') : s);
const altsOf = (t) => (t.alts || [{ from: t.from, to: t.to }]).map(a => ({ from: lf(a.from), to: lf(a.to) }));
const count = (s, needle) => s.split(needle).length - 1;

// Strings whose presence proves a target is applied (used here and by `vane --doctor`).
const appliedNeedles = (t) => [...altsOf(t).map(a => a.to), ...(t.marker ? [lf(t.marker)] : [])];
const isApplied = (s, t) => appliedNeedles(t).some(n => s.includes(n));

// Pure: { file: content } + targets -> { next: { file: content }, applied, skipped, errors, status }.
// `status` has one { name, status } per target, in order: applied (changed now), upgraded (changed now, from an earlier
// Fane version: the matching alts entry's ladder label does not start with 'fresh'), already, skipped or error.
function planPatch(contents, targets) {
  const next = { ...contents };
  const applied = [], skipped = [], errors = [], status = [];
  const done = (t, s) => status.push({ name: t.name, status: s });
  for (const t of targets) {
    const s = next[t.file];
    if (s === undefined) { errors.push(`${t.name}: ${t.file} not found`); done(t, 'error'); continue; }
    if (isApplied(s, t)) { done(t, 'already'); continue; }
    const alts = altsOf(t);
    const k = alts.findIndex(a => count(s, a.from) === 1);
    if (k < 0) {
      if (t.optional && alts.every(a => count(s, a.from) === 0)) { skipped.push(`${t.name} (${t.optional})`); done(t, 'skipped'); continue; }
      const versions = t.ladder ? ` (known versions: ${t.ladder.join(', ')})` : '';
      errors.push(`${t.name}: expected 1 match, found ${alts.map(a => count(s, a.from)).join('/')}${versions}`);
      done(t, 'error');
      continue;
    }
    next[t.file] = s.replace(alts[k].from, () => alts[k].to);
    applied.push(t.name);
    done(t, t.ladder && !String(t.ladder[k]).startsWith('fresh') ? 'upgraded' : 'applied');
  }
  for (const [file, s] of Object.entries(next)) {
    if (s === contents[file] || errors.length || file.endsWith('.css')) continue; // a stylesheet is not JavaScript
    try { new vm.Script(s, { filename: file }); } catch (err) { errors.push(`${file}: patched bundle does not parse (${err.message})`); }
  }
  return { next, applied, skipped, errors, status };
}

function run(name, targets, io = fs) { // `io`: tests pass a fake file system
  const files = [...new Set(targets.map(t => t.file))];
  const contents = {};
  for (const f of files) {
    try { contents[f] = io.readFileSync(f, 'utf8'); } catch { /* reported by planPatch */ }
  }
  const { next, applied, skipped, errors, status } = planPatch(contents, targets);
  for (const s of skipped) console.log(`${name}: skipped ${s}`);
  if (errors.length) {
    for (const e of errors) console.error(`${name}: ${e}`);
    console.error(`${name}: not patching anything`);
    process.exitCode = 1;
    return;
  }
  if (!applied.length) return console.log(`${name}: already patched`);
  // Every new bundle and every backup is written in full before any bundle is replaced, so a failing write (disk
  // full) leaves no file patched without its partner (an image hook without the route that serves its links).
  // What is left to do after that is renames only.
  const changed = files.filter(f => next[f] !== contents[f]);
  const madeBaks = [];
  const renamed = [];
  const dropTemporaries = () => {
    for (const f of changed) io.rmSync(`${f}.fane-tmp`, { force: true });
    for (const b of madeBaks) io.rmSync(b, { force: true });
  };
  try {
    for (const f of changed) {
      const st = io.statSync(f); // the renamed file keeps the bundle's mode and owner
      io.writeFileSync(`${f}.fane-tmp`, next[f], { mode: st.mode });
      try { io.chownSync(`${f}.fane-tmp`, st.uid, st.gid); } catch { /* not root: the owner is already ours */ }
    }
    for (const f of changed) {
      if (io.existsSync(`${f}.bak`)) continue;
      io.writeFileSync(`${f}.bak`, contents[f]);
      madeBaks.push(`${f}.bak`);
    }
  } catch (err) {
    dropTemporaries();
    throw err;
  }
  try {
    for (const f of changed) { io.renameSync(`${f}.fane-tmp`, f); renamed.push(f); }
  } catch (err) {
    // Put back what this run read (not the .bak: that holds the first-ever original), so no bundle stays patched
    // without its partner.
    for (const f of renamed) {
      try { io.writeFileSync(f, contents[f]); } catch (e) { console.error(`${name}: could not restore ${f} (${e.message})`); }
    }
    dropTemporaries();
    throw err;
  }
  // "patched N of M" counts every target now in place; the line keeps "patched" (scripts/apply.mjs looks for it) and
  // never says "already patched" unless nothing changed.
  const n = (s) => status.filter(x => x.status === s).length;
  const inPlace = n('applied') + n('upgraded') + n('already');
  const detail = [`${applied.length} changed now`, n('upgraded') && `${n('upgraded')} of them upgraded`, n('already') && `${n('already')} already applied`, n('skipped') && `${n('skipped')} optional skipped`].filter(Boolean);
  console.log(`${name}: patched ${inPlace} of ${targets.length} targets (${detail.join(', ')}; backups: *.bak)`);
}

module.exports = { run, planPatch, isApplied, appliedNeedles };
