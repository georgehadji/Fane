// Follow-up edits of a report: it is told by its three fixed sections, the editor keeps them and the table, the hook says report-edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { createArticleEditor, parseArticleAnswer, hasReportShape } = await import('../write/edit.mjs');
const { renderArticleResult } = await import('../write/present.mjs');
const { handleArticleRequest } = await import('../write/vane-hook.mjs');
const { tagged } = await import('../image/present.mjs');
const { prompts } = await import('../write/prompts.mjs');

const SOURCES = [
  { title: 'Heat pumps in cold climates', url: 'https://example.org/a', content: '' },
  { title: 'Cold-climate challenge', url: 'https://example.org/b', content: '' },
];
const REPORT = `# Heat pumps in cold climates

## Summary
Cold-climate heat pumps keep most of their heating capacity far below freezing [1]. Field tests since 2021 back this up [2], and the sources agree on the main figures.

## Performance at low temperatures
Modern units keep over 70% of their capacity at -26°C [1]. The challenge ran from 2021 to 2023 and set the benchmarks that vendors now publish [2], so buyers can compare models on the same basis in northern regions.

## Key figures

| Figure | Value |
|:--- |:--- |
| Capacity at -26°C | Over 70% [1] |
| Challenge years | 2021-2023 [2] |

## Where the sources disagree or are thin
The sources agree on the main figures; running costs against gas furnaces are thinner, because neither source states them as fixed numbers.`;

const answer = (over = {}) => tagged(renderArticleResult({
  ok: true, article: `${REPORT}\n\n## Sources\n\n1. [Heat pumps in cold climates](https://example.org/a)\n2. [Cold-climate challenge](https://example.org/b)`, language: 'en', mode: 'speed',
  words: 130, sources: SOURCES, degraded: [], checks: { ok: true, items: [] }, cost: 0.01, ms: 1000, ...over,
}));

const editClient = (text) => {
  const calls = [];
  return { calls, chat: async (body) => { calls.push(body.messages); return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { cost: 0.002 } }; } };
};
const CHAINS = { draft: ['alpha/m1'] };
const MODELS = [{ id: 'alpha/m1', name: 'M1', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000004' }, context_length: 100000 }];
const TRIAL = { 'alpha/m1': { en: { ok: true, tellsPerThousand: 0 }, el: { ok: true, tellsPerThousand: 0 }, json: { ok: true } } };
const ui = () => { const blocks = new Map(); return { blocks, emit: (x) => { blocks.set('b1', x); return 'b1'; }, update: (id, x) => blocks.set(id, x) }; };

test('hasReportShape: all three fixed sections, English or Greek; an article is not a report', () => {
  assert.equal(hasReportShape(REPORT), true);
  assert.equal(hasReportShape('# T\n\n## Σύνοψη\nx\n\n## Βασικά στοιχεία\nx\n\n## Όπου οι πηγές διαφωνούν ή είναι περιορισμένες\nx'), true);
  assert.equal(hasReportShape(REPORT.replace('## Key figures', '## Numbers')), false);
  assert.equal(hasReportShape('# T\n\n## Summary\nx'), false);
});

test('parseArticleAnswer flags a report answer, and only a report', () => {
  const r = parseArticleAnswer(answer());
  assert.equal(r.report, true);
  assert.match(r.body, /## Key figures/);
  assert.equal(r.sources.length, 2);
  const article = parseArticleAnswer(answer({ article: `# An article\n\n${'Plain words in a paragraph of an article. '.repeat(20)}\n\n## Sources\n\n1. [A](https://example.org/a)` }));
  assert.equal('report' in article, false);
});

test('the rewrite prompt of a report names its fixed sections in the language it ends up in', () => {
  const en = prompts.rewrite({ lang: 'en', article: REPORT, sources: SOURCES, instruction: 'shorter', format: 'report' }).user;
  assert.match(en, /"## Summary" first/);
  assert.match(en, /"## Key figures" as a Markdown table/);
  assert.match(en, /"## Where the sources disagree or are thin" last/);
  const el = prompts.rewrite({ lang: 'el', article: REPORT, sources: SOURCES, instruction: 'translate it', format: 'report' }).user;
  assert.match(el, /"## Σύνοψη" first/);
  assert.doesNotMatch(prompts.rewrite({ lang: 'en', article: REPORT, sources: SOURCES, instruction: 'shorter', format: 'article' }).user, /fixed sections/);
});

test('the editor edits a report with its rule, keeps the sections and the table, and renumbers', async () => {
  const edited = REPORT.replace('Modern units keep over 70% of their capacity at -26°C [1].', 'Modern units keep over 70% of capacity at -26°C [1].');
  const client = editClient(edited);
  const edit = createArticleEditor({ client });
  const r = await edit({ body: REPORT, sources: SOURCES, instruction: 'tighten the second section', lang: 'en', format: 'report', mode: 'speed', chains: CHAINS, prices: {} });
  assert.equal(r.ok, true);
  assert.ok(hasReportShape(r.article));
  assert.match(r.article, /\| Capacity at -26°C \| Over 70% \[1\] \|/);
  assert.match(r.article, /## Sources/);
  assert.match(client.calls[0][1].content, /This is a research report with fixed sections/);
});

test('an edit that drops a fixed section or the table is refused, and the report stays', async () => {
  const noSection = REPORT.replace(/\n## Where the sources[\s\S]*$/, '');
  const noTable = REPORT.replace(/\| Figure[\s\S]*?\n\n/, 'The key figures are in the text.\n\n');
  for (const [name, text] of [['section', noSection], ['table', noTable]]) {
    const edit = createArticleEditor({ client: editClient(text) });
    const r = await edit({ body: REPORT, sources: SOURCES, instruction: 'shorter', lang: 'en', format: 'report', chains: CHAINS, prices: {} });
    assert.equal(r.ok, false, name);
    assert.match(r.error, /report was not changed/, name);
  }
  // the same text passes for an article: the check is the report's
  const edit = createArticleEditor({ client: editClient(noSection) });
  assert.equal((await edit({ body: REPORT, sources: SOURCES, instruction: 'shorter', lang: 'en', chains: CHAINS, prices: {} })).ok, true);
});

test('"make it shorter" after a report goes to the report editor (feature report-edit) and keeps its shape', async () => {
  const u = ui(), lines = [];
  const client = { ...editClient(REPORT.replace('Modern units keep over 70% of their capacity', 'Modern units keep over 70%')), models: async () => MODELS };
  const handled = await handleArticleRequest('make it shorter', { ...u, mode: 'speed', client, trial: TRIAL, lastAnswer: async () => answer(), research: async () => [], log: (m) => lines.push(m) });
  assert.equal(handled, true);
  const final = u.blocks.get('b1');
  assert.match(final, /## Key figures/);
  assert.match(final, /## Where the sources disagree or are thin/);
  assert.ok(lines.some(l => /"feature":"report-edit"/.test(l)), lines.join('\n'));
  assert.match(client.calls[0][1].content, /fixed sections/);
});
