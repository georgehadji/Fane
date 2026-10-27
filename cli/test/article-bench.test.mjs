import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { articleBody, measureArticle, judgeArticle, summarize, compareArticles, isFatalError } = await import('../../scripts/article-bench.mjs');
const { sourcesSection } = await import('../write/checks.mjs');

const sources = [
  { title: 'Tides in Orkney', url: 'https://www.example.org/orkney', content: 'The site supplied 1,200 homes in 2023.' },
  { title: 'Costs', url: 'https://example.net/costs', content: 'Costs fell by 40% between 2015 and 2023.' },
];
const body = '# Tidal power\n\nIt is important to note that the site supplied 1,200 homes in 2023 [1]. Costs fell by 40% [2].';
const result = (over = {}) => ({
  article: body + sourcesSection(sources, 'en'), sources, language: 'en', words: 660, targetWords: 600, ms: 125_400, cost: 0.31234, calls: 9,
  checks: { items: [{ name: 'citations', level: 'ok' }, { name: 'length', level: 'fail' }] }, degraded: ['trim failed'], claimSupport: 0.9, audit: { score: 0.8 },
  phases: [{ phase: 'draft', model: 'a/x' }], ...over,
});

test('articleBody drops exactly the sources list the pipeline appended', () => {
  assert.equal(articleBody(result()), body);
  assert.equal(articleBody({ article: body, sources: [], language: 'en' }), body);
});

test('measureArticle: length miss, hosts, stock phrases, failed checks, self and judged scores', () => {
  const m = measureArticle(result(), { support: 0.75, claims: 4, audit: 0.7 });
  assert.equal(m.secs, 125);
  assert.equal(m.cost, 0.3123);
  assert.equal(m.wordsOff, 0.1);
  assert.equal(m.cited, 2);
  assert.equal(m.hosts, 2);
  assert.ok(m.tellsPer1k > 0); // "It is important to note"
  assert.equal(m.checkFails, 1);
  assert.equal(m.degraded, 1);
  assert.deepEqual([m.selfSupport, m.selfAudit, m.judgeSupport, m.judgeClaims, m.judgeAudit], [0.9, 0.8, 0.75, 4, 0.7]);
  assert.equal(measureArticle(result({ claimSupport: null, audit: null })).judgeSupport, null);
});

test('judgeArticle grades the final text without its sources list, with one fixed model', async () => {
  const seen = [];
  const call = async (role, prompt, opts) => {
    seen.push({ role, prompt, opts });
    if (role === 'factcheck') return { ok: true, cost: 0.01, data: { claims: [{ claim: 'a', verdict: 'supported' }, { claim: 'b', verdict: 'supported' }, { claim: 'c', verdict: 'unsupported' }] } };
    return { ok: true, cost: 0.02, data: { scores: { thesis_advancement: 1, claim_support: 1, internal_consistency: 1, transition_quality: 1, redundancy_removed: 1, citation_accuracy: 1 } } };
  };
  const j = await judgeArticle(call, 'judge/model', result());
  assert.deepEqual([j.support, j.claims, j.audit, j.problems], [0.667, 3, 1, []]);
  assert.deepEqual(j.failed.map(c => [c.claim, c.verdict]), [['c', 'unsupported']]);
  assert.ok(Math.abs(j.cost - 0.03) < 1e-9);
  assert.deepEqual(seen.map(s => s.opts.chain), [['judge/model'], ['judge/model']]);
  assert.ok(!seen[0].prompt.user.includes('## Sources'));
  assert.ok(seen[1].prompt.user.includes('"verdict":"unsupported"')); // the audit sees the judge's own ledger
});

test('judgeArticle: a failed step is recorded, a fatal one stops the run', async () => {
  const bad = await judgeArticle(async () => ({ ok: false, cost: 0, errors: ['j: not JSON'] }), 'j', result());
  assert.deepEqual([bad.support, bad.audit], [null, null]);
  assert.equal(bad.problems.length, 2);
  await assert.rejects(judgeArticle(async () => ({ ok: false, fatal: true, cost: 0, errors: ['j: 402'] }), 'j', result()), /judge: j: 402/);
});

test('a 401 or 402 in an article error stops the run; other failures do not', () => {
  assert.ok(isFatalError('vane: meta/muse-wonder: 402 This request would exceed your available credits'));
  assert.ok(isFatalError('vane: a/x: 401 Unauthorized'));
  assert.ok(!isFatalError('vane: no sources found for this topic (fetch failed)'));
  assert.ok(!isFatalError('vane: draft failed after 4020 ms'));
  assert.ok(!isFatalError(undefined));
});

test('summarize adds an ALL row per mode: the median of the topic medians', () => {
  const rows = summarize([
    { id: 'a', mode: 'quality', run: 1, judgeSupport: 0.6 },
    { id: 'a', mode: 'quality', run: 2, judgeSupport: 0.8 },
    { id: 'b', mode: 'quality', run: 1, judgeSupport: 0.9 },
    { id: 'c', mode: 'quality', run: 1, error: 'exit 1' },
  ]);
  const all = rows.find(r => r.id === 'ALL');
  assert.equal(all.judgeSupport, 0.8); // medians a 0.7, b 0.9
  assert.deepEqual([all.runs, all.failed], [4, 1]);
  const even = summarize([{ id: 'a', mode: 'q', run: 1, cost: 0.2385 }, { id: 'b', mode: 'q', run: 1, cost: 0.4906 }]);
  assert.equal(even.find(r => r.id === 'ALL').cost, 0.3646); // not 0.36455000000000004
});

test('compareArticles flags drops past the tolerance and ignores missing numbers', () => {
  const base = [{ id: 'ALL', mode: 'quality', failed: 0, judgeSupport: 0.8, judgeAudit: 0.75, tellsPer1k: 1, wordsOff: 0.05, cost: 0.4, secs: 500 }];
  const same = compareArticles(base, [{ ...base[0], judgeSupport: 0.75, cost: 0.5 }]);
  assert.deepEqual(same.regressions, []);
  const worse = compareArticles(base, [{ ...base[0], judgeSupport: 0.6, tellsPer1k: 4, cost: 0.7, secs: 800, judgeAudit: null }]);
  assert.equal(worse.regressions.length, 4);
  assert.ok(worse.regressions.some(r => /judged claim support 0.8 -> 0.6/.test(r)));
});
