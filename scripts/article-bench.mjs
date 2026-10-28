#!/usr/bin/env node
// Article-quality benchmark. Runs a fixed topic set (bench/articles.json) through `vane --article --json`,
// one article at a time, and has one fixed judge model grade each final article with the pipeline's own
// fact-check and audit prompts. The pipeline's self-reported numbers move when its prompts change, and its
// fact-check sees the draft rather than the final text, so the judge is what makes two runs comparable.
// Per run: time, cost, words against the target, sources cited and their hosts, stock phrases per 1,000
// words, failed checks, degraded steps, the pipeline's own claim support and audit score, and the judge's.
// Medians per topic and mode, plus an ALL row per mode (the median of the topic medians), go to
// bench/results/articles-<timestamp>.json, each article to the folder of the same name, so they can be read.
//
//   node scripts/article-bench.mjs --key-from-vane                                quality, 1 run, all topics
//   node scripts/article-bench.mjs --key-from-vane --modes balanced --only symplectic,ocean-el
//   node scripts/article-bench.mjs --key-from-vane --baseline bench/articles-baseline.json --fail-on-regression
//
// Every article is paid: a 500-word Greek Quality article cost about $0.37 in a live run, and the judge
// adds a few cents. --budget (default $5) stops before the next article once the spend has passed it.
// Needs OPENROUTER_API_KEY or --key-from-vane (the key of Vane's OpenRouter provider; never printed).
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULTS } from '../cli/vane.mjs';
import { createOpenRouterClient, findOpenRouterKey } from '../cli/image/openrouter.mjs';
import { sourcesSection } from '../cli/write/checks.mjs';
import { auditResult, claimLedger, claimSupportRatio } from '../cli/write/gate.mjs';
import { countTells } from '../cli/core/language.mjs';
import { createRoleCaller } from '../cli/write/llm.mjs';
import { MODES, tokensFor } from '../cli/write/models.mjs';
import { prompts } from '../cli/write/prompts.mjs';
import { aggregate, median, runCli } from './bench.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Passed the trial in both languages and is in no Quality chain (claude-sonnet-5.5 leads the Quality audit chain).
// Balanced chains do use it: pass another --judge there. A run marks an article written partly by the judge.
export const DEFAULT_JUDGE = 'openai/gpt-6.1-terra-pro';

// Regression rules for --baseline: a metric regresses when it moves past these limits.
export const TOLERANCE = {
  supportDrop: 0.1, // the judge's supported share of claims fell by more than 0.1
  auditDrop: 0.1, // the judge's audit score fell by more than 0.1
  tellsRise: 2, // stock phrases per 1,000 words rose by more than 2
  wordsOffRise: 0.15, // the miss against the target length grew by more than 15 points
  costRise: 0.5, // cost rose by more than 50%
  secsRise: 0.5, // time rose by more than 50% and by more than a minute
};

export const METRICS = ['secs', 'cost', 'calls', 'words', 'wordsOff', 'cited', 'hosts', 'tellsPer1k', 'checkFails', 'degraded', 'selfSupport', 'selfAudit', 'judgeSupport', 'judgeClaims', 'judgeAudit'];

// A failed article whose error is a bad key or no credits: every later article would fail the same way.
// (In the first baseline run a 402 was followed by "no sources found (fetch failed)": Vane's own research
// calls OpenRouter too.)
export const isFatalError = (error) => /\b40[12]\b/.test(String(error || ''));

const round = (x, n = 3) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : null);

// The article without the sources list the pipeline appends (text + sourcesSection(used, lang)).
export function articleBody(r) {
  const article = String(r.article || '');
  const tail = sourcesSection(r.sources || [], r.language);
  return tail && article.endsWith(tail) ? article.slice(0, -tail.length).trimEnd() : article;
}

// One `vane --article --json` result and the judge's verdict -> metrics.
export function measureArticle(r, judge = {}) {
  const sources = r.sources || [];
  const hosts = new Set(sources.map(s => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean));
  return {
    secs: round((r.ms || 0) / 1000, 0),
    cost: round(r.cost || 0, 4),
    calls: r.calls ?? null,
    words: r.words ?? null,
    wordsOff: r.targetWords && r.words != null ? round(Math.abs(r.words - r.targetWords) / r.targetWords) : null,
    cited: sources.length,
    hosts: hosts.size,
    tellsPer1k: countTells(articleBody(r), r.language).perThousand,
    checkFails: (r.checks?.items || []).filter(i => i.level === 'fail').length,
    degraded: (r.degraded || []).length,
    selfSupport: r.claimSupport ?? null,
    selfAudit: r.audit?.score ?? null,
    judgeSupport: judge.support ?? null,
    judgeClaims: judge.claims ?? null,
    judgeAudit: judge.audit ?? null,
  };
}

// The judge reads the final article and the sources it cites (numbered as in the article) with the pipeline's
// fact-check prompt, then audits it with its own claim ledger. -> { support, claims, audit, cost, problems }.
// A fatal answer (bad key, no credits) throws, because every later article would fail the same way.
export async function judgeArticle(call, model, r) {
  const article = articleBody(r), sources = r.sources || [], lang = r.language;
  const opts = (role) => ({ chain: [model], maxTokens: tokensFor(role, 0, lang) });
  const out = { support: null, claims: null, audit: null, cost: 0, problems: [], failed: [] };
  const f = await call('factcheck', prompts.factcheck({ lang, article, sources }), opts('factcheck'));
  out.cost += f.cost;
  if (f.fatal) throw new Error(`judge: ${f.errors[0]}`);
  let ledger = [];
  if (f.ok) {
    ledger = claimLedger(f.data);
    out.claims = ledger.length;
    out.support = claimSupportRatio(ledger);
    // why support moved: the first tuning run lost 0.08 and the saved metrics could not say which claims failed
    out.failed = ledger.filter(c => c.verdict !== 'supported').map(({ claim, source, verdict, note }) => ({ claim, source, verdict, note }));
  } else out.problems.push(`fact-check: ${f.errors.at(-1)}`);
  const a = await call('audit', prompts.audit({ lang, article, ledger }), opts('audit'));
  out.cost += a.cost;
  if (a.fatal) throw new Error(`judge: ${a.errors[0]}`);
  if (a.ok) out.audit = auditResult(a.data.scores).score;
  else out.problems.push(`audit: ${a.errors.at(-1)}`);
  return out;
}

// Medians per topic and mode, then one ALL row per mode: the median of the topic medians.
export function summarize(runs) {
  const rows = aggregate(runs, METRICS);
  for (const mode of [...new Set(rows.map(r => r.mode))]) {
    const rs = rows.filter(r => r.mode === mode);
    const all = { id: 'ALL', mode, runs: rs.reduce((n, r) => n + r.runs, 0), failed: rs.reduce((n, r) => n + r.failed, 0) };
    for (const m of METRICS) all[m] = round(median(rs.map(r => r[m])), 4); // an even count averages two values
    rows.push(all);
  }
  return rows;
}

// Compare summaries; returns rows with deltas and a list of regression messages.
export function compareArticles(base, cur, tol = TOLERANCE) {
  const byKey = new Map(base.map(r => [`${r.id}|${r.mode}`, r]));
  const rows = [], regressions = [];
  for (const c of cur) {
    const b = byKey.get(`${c.id}|${c.mode}`);
    if (!b) continue;
    const name = `${c.id}/${c.mode}`;
    const has = (k) => b[k] != null && c[k] != null;
    rows.push({ name, base: b, cur: c });
    if (c.failed > b.failed) regressions.push(`${name}: ${c.failed} failed runs (baseline ${b.failed})`);
    if (has('judgeSupport') && c.judgeSupport < b.judgeSupport - tol.supportDrop) regressions.push(`${name}: judged claim support ${b.judgeSupport} -> ${c.judgeSupport}`);
    if (has('judgeAudit') && c.judgeAudit < b.judgeAudit - tol.auditDrop) regressions.push(`${name}: judged audit ${b.judgeAudit} -> ${c.judgeAudit}`);
    if (has('tellsPer1k') && c.tellsPer1k > b.tellsPer1k + tol.tellsRise) regressions.push(`${name}: stock phrases per 1,000 words ${b.tellsPer1k} -> ${c.tellsPer1k}`);
    if (has('wordsOff') && c.wordsOff > b.wordsOff + tol.wordsOffRise) regressions.push(`${name}: length miss ${b.wordsOff} -> ${c.wordsOff}`);
    if (has('cost') && b.cost > 0 && c.cost > b.cost * (1 + tol.costRise)) regressions.push(`${name}: cost $${b.cost} -> $${c.cost}`);
    if (has('secs') && c.secs > b.secs * (1 + tol.secsRise) && c.secs - b.secs > 60) regressions.push(`${name}: time ${b.secs}s -> ${c.secs}s`);
  }
  return { rows, regressions };
}

async function apiKey(fromVane) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (!fromVane) throw new Error('Set OPENROUTER_API_KEY or pass --key-from-vane.');
  const res = await fetch(`${DEFAULTS.url}/api/config`, { signal: AbortSignal.timeout(10_000) });
  const key = findOpenRouterKey((await res.json()).values?.modelProviders);
  if (!key) throw new Error(`No Vane provider with an OpenRouter Base URL and an API key at ${DEFAULTS.url}.`);
  return key;
}

const fmt = (x) => (x == null ? '-' : String(x));
const COLS = ['secs', 'cost', 'words', 'wordsOff', 'cited', 'hosts', 'tellsPer1k', 'checkFails', 'degraded', 'selfSupport', 'selfAudit', 'judgeSupport', 'judgeAudit'];
const LABEL = { wordsOff: 'len-miss', tellsPer1k: 'tells/1k', checkFails: 'fails', degraded: 'degr', selfSupport: 'self-sup', selfAudit: 'self-aud', judgeSupport: 'judge-sup', judgeAudit: 'judge-aud' };

function printSummary(summary) {
  console.log(`\n${'topic/mode'.padEnd(24)}${COLS.map(c => (LABEL[c] || c).padStart(10)).join('')}  failed`);
  for (const r of summary) console.log(`${`${r.id}/${r.mode}`.padEnd(24)}${COLS.map(c => fmt(r[c]).padStart(10)).join('')}  ${r.failed}/${r.runs}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      modes: { type: 'string', default: 'quality' },
      runs: { type: 'string', default: '1' },
      only: { type: 'string' },
      topics: { type: 'string', default: join(ROOT, 'bench', 'articles.json') },
      judge: { type: 'string', default: DEFAULT_JUDGE },
      budget: { type: 'string', default: '5' },
      out: { type: 'string' },
      baseline: { type: 'string' },
      'fail-on-regression': { type: 'boolean', default: false },
      'key-from-vane': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: node scripts/article-bench.mjs [--key-from-vane] [--modes speed,balanced,quality] [--runs N] [--only id,id]\n                                    [--topics file] [--judge model] [--budget USD] [--out file] [--baseline file] [--fail-on-regression]');
    return;
  }
  const modes = values.modes.split(',').map(s => s.trim()).filter(Boolean);
  for (const m of modes) if (!MODES.includes(m)) throw new Error(`invalid mode "${m}" (${MODES.join(', ')})`);
  const runs = Number(values.runs);
  if (!(Number.isInteger(runs) && runs >= 1)) throw new Error(`invalid --runs "${values.runs}"`);
  const budget = Number(values.budget);
  if (!(budget > 0)) throw new Error(`invalid --budget "${values.budget}"`);
  const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;
  const topics = JSON.parse(readFileSync(values.topics, 'utf8')).filter(t => !only || only.has(t.id));
  if (!topics.length) throw new Error('no topics selected');

  const key = await apiKey(values['key-from-vane']);
  const env = { ...process.env, OPENROUTER_API_KEY: key }; // the CLI reads it from there; never printed
  const call = createRoleCaller({ client: createOpenRouterClient({ apiKey: key }), log: (m) => console.log(`  judge: ${m}`) });
  const file = values.out || join(ROOT, 'bench', 'results', `articles-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const dir = file.replace(/\.json$/, '');
  mkdirSync(dir, { recursive: true });

  const results = [];
  const total = topics.length * modes.length * runs;
  let n = 0, spent = 0;
  const save = () => writeFileSync(file, JSON.stringify({ meta: { date: new Date().toISOString(), judge: values.judge, modes, runs, spent: round(spent, 4) }, runs: results, summary: summarize(results) }, null, 2));
  try {
    run: for (let run = 1; run <= runs; run++) {
      for (const mode of modes) {
        for (const t of topics) {
          if (spent >= budget) {
            console.log(`budget of $${budget} reached ($${spent.toFixed(2)} spent): ${total - n} article(s) not run`);
            break run;
          }
          n++;
          const args = ['--article', t.q, '--json', '-o', mode, ...(t.words ? ['--words', String(t.words)] : [])];
          const r = await runCli(args, (mode === 'quality' ? 1200 : 600) * 1000, env);
          let row = { id: t.id, mode, run }, out = null;
          try { out = JSON.parse(r.out); } catch { row.error = (r.err || `exit ${r.code}`).trim().split('\n').pop().slice(0, 200); }
          if (out) {
            // shortcut: a failed run prints no cost, so its spend is not counted against --budget
            spent += out.cost || 0;
            writeFileSync(join(dir, `${t.id}-${mode}-${run}.md`), out.article);
            const judge = await judgeArticle(call, values.judge, out);
            spent += judge.cost;
            row = { ...row, ...measureArticle(out, judge), judgeCost: round(judge.cost, 4) };
            if (judge.problems.length) row.judgeProblems = judge.problems;
            if (judge.failed.length) row.judgeFailed = judge.failed;
            if ((out.phases || []).some(p => p.model === values.judge)) row.selfJudged = true;
          }
          results.push(row);
          console.log(`[${n}/${total}] ${t.id}/${mode} run ${run}: ${row.error ? `FAILED (${row.error})` : `${row.secs}s, $${row.cost}, ${row.words} words, judge support ${fmt(row.judgeSupport)}, audit ${fmt(row.judgeAudit)}${row.selfJudged ? ' (the judge model also wrote part of it)' : ''}`}`);
          if (isFatalError(row.error)) {
            console.log(`stopped: OpenRouter refused the key or the credits ran out; ${total - n} article(s) not run`);
            process.exitCode = 1;
            break run;
          }
        }
      }
    }
  } finally {
    save();
  }

  const summary = summarize(results);
  printSummary(summary);
  console.log(`\nspent ≈ $${spent.toFixed(2)}; saved ${file} (articles in ${dir})`);

  if (values.baseline) {
    const base = JSON.parse(readFileSync(values.baseline, 'utf8'));
    if (base.meta?.judge && base.meta.judge !== values.judge) console.log(`\nwarning: the baseline was judged by ${base.meta.judge}, this run by ${values.judge}; judged scores are not comparable`);
    const { rows, regressions } = compareArticles(base.summary, summary);
    console.log(`\nAgainst ${values.baseline}:`);
    for (const { name, base: b, cur: c } of rows) console.log(`  ${name.padEnd(22)} judge-sup ${fmt(b.judgeSupport)} -> ${fmt(c.judgeSupport)}, judge-aud ${fmt(b.judgeAudit)} -> ${fmt(c.judgeAudit)}, tells/1k ${fmt(b.tellsPer1k)} -> ${fmt(c.tellsPer1k)}, len-miss ${fmt(b.wordsOff)} -> ${fmt(c.wordsOff)}, $${fmt(b.cost)} -> $${fmt(c.cost)}, ${fmt(b.secs)}s -> ${fmt(c.secs)}s`);
    if (regressions.length) {
      console.log(`\n${regressions.length} regression(s):\n${regressions.map(r => `  - ${r}`).join('\n')}`);
      if (values['fail-on-regression']) process.exitCode = 1;
    } else console.log('\nNo regressions.');
  }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) main().catch(err => { console.error(`article-bench: ${err.message}`); process.exit(1); });
