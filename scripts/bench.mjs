#!/usr/bin/env node
// Answer-quality benchmark for a local Vane + Fane install. Runs a fixed question set
// through the CLI (`vane ... -j --verify`), one query at a time, and records per run:
// time, words, sources, distinct hosts, citations used, citation support (see --verify),
// and the share of non-Latin-script source titles (a locale-leak signal). Medians per
// question and mode go to bench/results/<timestamp>.json; --baseline compares against an
// earlier result file and flags regressions.
//
//   node scripts/bench.mjs                                 speed mode, 1 run, all questions
//   node scripts/bench.mjs --modes speed,balanced --runs 3 -m claude-haiku-5-5
//   node scripts/bench.mjs --only coffee,keyboard --baseline bench/baseline.json --fail-on-regression
//
// Each run is a real query (model cost, search requests). 6 questions x 3 modes x 3 runs
// is 54 queries; keep --runs low unless you need tighter medians.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Regression rules for --baseline: a metric regresses when it moves past these limits.
export const TOLERANCE = {
  sourcesDrop: 0.25, // median sources fell by more than 25% (and baseline had >= 4)
  supportDrop: 0.1, // supported share of cited sentences fell by more than 0.1
  secsRise: 0.5, // median time rose by more than 50% and by more than 10s
  nonLatinRise: 0.1, // non-Latin source titles rose by more than 10 points
};

export const median = (xs) => {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const NON_LATIN = /[Ͱ-ϿЀ-ӿ֐-ۿ฀-๿぀-ヿ㐀-鿿가-힯]/;

// One CLI JSON result -> metrics.
export function measure(out) {
  const sources = out.sources || [];
  const hosts = new Set(sources.map(s => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean));
  const v = out.verification || {};
  return {
    words: String(out.message || '').split(/\s+/).filter(Boolean).length,
    sources: sources.length,
    hosts: hosts.size,
    citesUsed: new Set((String(out.message || '').match(/\[\d+\]/g) || [])).size,
    supportRate: v.supportRate ?? null,
    weak: v.weak ? v.weak.length : null,
    numbersMissing: v.numbersMissing ? v.numbersMissing.length : null,
    invalidCitations: v.invalidCitations ? v.invalidCitations.length : null,
    uncited: v.uncited ?? null,
    nonLatin: sources.length ? Math.round((sources.filter(s => NON_LATIN.test(s.title || '')).length / sources.length) * 1000) / 1000 : 0,
  };
}

const METRICS = ['secs', 'words', 'sources', 'hosts', 'citesUsed', 'supportRate', 'weak', 'numbersMissing', 'invalidCitations', 'uncited', 'nonLatin'];

// Runs -> one summary row per question and mode (medians; failed runs counted, not averaged).
export function aggregate(runs) {
  const groups = new Map();
  for (const r of runs) {
    const k = `${r.id}|${r.mode}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map(rs => {
    const ok = rs.filter(r => !r.error);
    const row = { id: rs[0].id, mode: rs[0].mode, runs: rs.length, failed: rs.length - ok.length };
    for (const m of METRICS) row[m] = median(ok.map(r => r[m]));
    return row;
  });
}

// Compare summaries; returns rows with deltas and a list of regression messages.
export function compare(base, cur, tol = TOLERANCE) {
  const byKey = new Map(base.map(r => [`${r.id}|${r.mode}`, r]));
  const rows = [];
  const regressions = [];
  for (const c of cur) {
    const b = byKey.get(`${c.id}|${c.mode}`);
    if (!b) continue;
    const name = `${c.id}/${c.mode}`;
    rows.push({ name, base: b, cur: c });
    if (c.failed > b.failed) regressions.push(`${name}: ${c.failed} failed runs (baseline ${b.failed})`);
    if (b.sources >= 4 && c.sources != null && c.sources < b.sources * (1 - tol.sourcesDrop)) regressions.push(`${name}: sources ${b.sources} -> ${c.sources}`);
    if (b.supportRate != null && c.supportRate != null && c.supportRate < b.supportRate - tol.supportDrop) regressions.push(`${name}: support ${b.supportRate} -> ${c.supportRate}`);
    if (b.secs != null && c.secs != null && c.secs > b.secs * (1 + tol.secsRise) && c.secs - b.secs > 10) regressions.push(`${name}: time ${b.secs}s -> ${c.secs}s`);
    if (b.nonLatin != null && c.nonLatin != null && c.nonLatin > b.nonLatin + tol.nonLatinRise) regressions.push(`${name}: non-Latin titles ${b.nonLatin} -> ${c.nonLatin}`);
  }
  return { rows, regressions };
}

function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(ROOT, 'cli', 'vane.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const kill = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err, secs: Math.round((Date.now() - t0) / 100) / 10 }); });
  });
}

function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`docker exit ${code}`))));
  });
}

const fmt = (x) => (x == null ? '-' : String(x));

function printSummary(summary) {
  const cols = ['secs', 'words', 'sources', 'hosts', 'citesUsed', 'supportRate', 'weak', 'numbersMissing', 'invalidCitations', 'nonLatin'];
  const label = { citesUsed: 'cited', supportRate: 'support', numbersMissing: 'num-miss', invalidCitations: 'bad-cite', nonLatin: 'nonLatin' };
  console.log(`\n${'question/mode'.padEnd(24)}${cols.map(c => (label[c] || c).padStart(9)).join('')}  failed`);
  for (const r of summary) console.log(`${`${r.id}/${r.mode}`.padEnd(24)}${cols.map(c => fmt(r[c]).padStart(9)).join('')}  ${r.failed}/${r.runs}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      modes: { type: 'string', default: 'speed' },
      runs: { type: 'string', default: '1' },
      model: { type: 'string', short: 'm' },
      only: { type: 'string' },
      questions: { type: 'string', default: join(ROOT, 'bench', 'questions.json') },
      out: { type: 'string' },
      baseline: { type: 'string' },
      'fail-on-regression': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: node scripts/bench.mjs [--modes speed,balanced,quality] [--runs N] [-m model] [--only id,id]\n                            [--questions file] [--out file] [--baseline file] [--fail-on-regression]');
    return;
  }
  const modes = values.modes.split(',').map(s => s.trim()).filter(Boolean);
  const runs = Number(values.runs);
  if (!(runs >= 1)) throw new Error(`invalid --runs "${values.runs}"`);
  const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;
  const questions = JSON.parse(readFileSync(values.questions, 'utf8')).filter(q => !only || only.has(q.id));
  if (!questions.length) throw new Error('no questions selected');

  const results = [];
  const total = questions.length * modes.length * runs;
  let n = 0;
  for (let run = 1; run <= runs; run++) {
    for (const mode of modes) {
      for (const q of questions) {
        n++;
        const args = [q.q, '-j', '--verify', '-o', mode, '-s', q.sources.join(','), ...(values.model ? ['-m', values.model] : [])];
        const timeoutMs = (mode === 'quality' ? 660 : 240) * 1000; // CLI timeout + margin
        const r = await runCli(args, timeoutMs);
        let row = { id: q.id, mode, run, secs: r.secs, exit: r.code };
        try { row = { ...row, ...measure(JSON.parse(r.out)) }; } catch { row.error = (r.err || `exit ${r.code}`).trim().split('\n').pop().slice(0, 200); }
        results.push(row);
        console.log(`[${n}/${total}] ${q.id}/${mode} run ${run}: ${row.error ? `FAILED (${row.error})` : `${row.secs}s, ${row.sources} sources, support ${fmt(row.supportRate)}`}`);
      }
    }
  }

  const summary = aggregate(results);
  printSummary(summary);
  let image = null;
  try { image = (await runDocker(['inspect', '-f', '{{.Image}}', process.env.VANE_CONTAINER || 'vane'])).trim() || null; } catch { /* not essential */ }
  const file = values.out || join(ROOT, 'bench', 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ meta: { date: new Date().toISOString(), model: values.model || process.env.VANE_CHAT_MODEL || null, modes, runs, image }, runs: results, summary }, null, 2));
  console.log(`\nSaved ${file}`);

  if (values.baseline) {
    const base = JSON.parse(readFileSync(values.baseline, 'utf8')).summary;
    const { rows, regressions } = compare(base, summary);
    console.log(`\nAgainst ${values.baseline}:`);
    for (const { name, base: b, cur: c } of rows) console.log(`  ${name.padEnd(22)} secs ${fmt(b.secs)} -> ${fmt(c.secs)}, sources ${fmt(b.sources)} -> ${fmt(c.sources)}, support ${fmt(b.supportRate)} -> ${fmt(c.supportRate)}, non-Latin ${fmt(b.nonLatin)} -> ${fmt(c.nonLatin)}`);
    if (regressions.length) {
      console.log(`\n${regressions.length} regression(s):\n${regressions.map(r => `  - ${r}`).join('\n')}`);
      if (values['fail-on-regression']) process.exitCode = 1;
    } else console.log('\nNo regressions.');
  }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) main().catch(err => { console.error(`bench: ${err.message}`); process.exit(1); });
