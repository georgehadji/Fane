// The one patch engine. Every patches/patch-*.js only declares TARGETS and calls run().
// A target: { name, file, from, to } or { name, file, alts: [{ from, to }, ...] }, plus
// optional `marker` (proof the target is applied when a later patch edits the `to` text)
// and `optional` (reason; skipped instead of failing when no `from` matches).
// Contract: check every target first and change nothing on any mismatch (exit 1); never
// write a bundle that does not parse; keep a .bak of each original; re-running is a no-op.
const fs = require('fs');
const vm = require('vm');

const altsOf = (t) => t.alts || [{ from: t.from, to: t.to }];
const count = (s, needle) => s.split(needle).length - 1;

// Strings whose presence proves a target is applied (used here and by `vane --doctor`).
const appliedNeedles = (t) => [...altsOf(t).map(a => a.to), ...(t.marker ? [t.marker] : [])];
const isApplied = (s, t) => appliedNeedles(t).some(n => s.includes(n));

// Pure: { file: content } + targets -> { next: { file: content }, applied, skipped, errors }
function planPatch(contents, targets) {
  const next = { ...contents };
  const applied = [], skipped = [], errors = [];
  for (const t of targets) {
    const s = next[t.file];
    if (s === undefined) { errors.push(`${t.name}: ${t.file} not found`); continue; }
    if (isApplied(s, t)) continue;
    const hit = altsOf(t).find(a => count(s, a.from) === 1);
    if (!hit) {
      if (t.optional && altsOf(t).every(a => count(s, a.from) === 0)) { skipped.push(`${t.name} (${t.optional})`); continue; }
      errors.push(`${t.name}: expected 1 match, found ${altsOf(t).map(a => count(s, a.from)).join('/')}`);
      continue;
    }
    next[t.file] = s.replace(hit.from, () => hit.to);
    applied.push(t.name);
  }
  for (const [file, s] of Object.entries(next)) {
    if (s === contents[file] || errors.length || file.endsWith('.css')) continue; // a stylesheet is not JavaScript
    try { new vm.Script(s, { filename: file }); } catch (err) { errors.push(`${file}: patched bundle does not parse (${err.message})`); }
  }
  return { next, applied, skipped, errors };
}

function run(name, targets) {
  const files = [...new Set(targets.map(t => t.file))];
  const contents = {};
  for (const f of files) {
    try { contents[f] = fs.readFileSync(f, 'utf8'); } catch { /* reported by planPatch */ }
  }
  const { next, applied, skipped, errors } = planPatch(contents, targets);
  for (const s of skipped) console.log(`${name}: skipped ${s}`);
  if (errors.length) {
    for (const e of errors) console.error(`${name}: ${e}`);
    console.error(`${name}: not patching anything`);
    process.exitCode = 1;
    return;
  }
  if (!applied.length) return console.log(`${name}: already patched`);
  for (const f of files) {
    if (next[f] === contents[f]) continue;
    if (!fs.existsSync(`${f}.bak`)) fs.writeFileSync(`${f}.bak`, contents[f]);
    fs.writeFileSync(f, next[f]);
  }
  console.log(`${name}: patched ${applied.length} of ${targets.length} targets (backups: *.bak)`);
}

module.exports = { run, planPatch, isApplied, appliedNeedles };
