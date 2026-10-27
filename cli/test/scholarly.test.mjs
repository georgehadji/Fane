// Tests the paper-enrichment function that patches/patch-scholarly-sources.js injects
// into Vane's SearXNG client. Imported from the patch module, so the test runs exactly
// the code that ends up in the bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scholarly = require('../../patches/patch-scholarly-sources.js');
const social = require('../../patches/patch-social-sources.js');
const { planPatch } = require('../../patches/lib/apply-targets.js');
const enrich = eval(scholarly.ENRICH);
const clip = eval(scholarly.CLIP);

test('a CORE full text is clipped; short snippets and title-only results are untouched', () => {
  const long = { title: 'T', url: 'https://doi.org/10.1/x', content: 'x'.repeat(50_000) };
  assert.equal(clip(long).content.length, scholarly.LONG_RESULT_CHARS);
  const short = { title: 'T', content: 'abstract' };
  assert.equal(clip(short), short);
  const bare = { title: 'T' };
  assert.equal(clip(bare), bare);
});

// The SearXNG client as Vane ships it, and the targets of both patches that edit it.
const CLIENT = 'async function search(a){let b=await a.json(),c=b.results,d=b.suggestions;return{results:c,suggestions:d}}var cfg={searchConfig:{engines:["arxiv","google scholar","pubmed"]}};';
const pick = (mod, ...names) => mod.TARGETS.filter(t => names.includes(t.name)).map(t => ({ ...t, file: 'f' }));
const CLIENT_TARGETS = [...pick(scholarly, 'academic engines', 'paper metadata in results', 'long result text clipped'), ...pick(social, 'platform and date in results')];

test('the SearXNG client patches apply in file order, then re-run as a no-op, and clip before they read the text', async () => {
  const once = planPatch({ f: CLIENT }, CLIENT_TARGETS);
  assert.deepEqual(once.errors, []);
  assert.equal(once.applied.length, 4);
  assert.deepEqual(planPatch(once.next, CLIENT_TARGETS).applied, []);
  assert.match(once.next.f, /"semantic scholar","core\.ac\.uk"\]/);
  const run = new Function(`${once.next.f};return search;`)();
  const paper = { title: 'T', url: 'https://doi.org/10.1/x', authors: ['A'], doi: '10.1/x', content: 'y'.repeat(9000) };
  const { results: [r] } = await run({ json: async () => ({ results: [paper], suggestions: [] }) });
  assert.equal(r.fane_text.length, scholarly.LONG_RESULT_CHARS); // what Vane embeds
  assert.ok(r.content.startsWith('[A | doi:10.1/x] ') && r.content.length < 2100); // what the writer gets
});

test('a container patched before CORE was added gets core.ac.uk and the clip on the next run', () => {
  const before = CLIENT.replace('"pubmed"]', '"pubmed","openalex","crossref","semantic scholar"]');
  const out = planPatch({ f: before }, pick(scholarly, 'academic engines', 'long result text clipped'));
  assert.deepEqual(out.errors, []);
  assert.match(out.next.f, /engines:\["arxiv","google scholar","pubmed","openalex","crossref","semantic scholar","core\.ac\.uk"\]/);
  assert.match(out.next.f, /b\.results=\(b\.results\|\|\[\]\)\.map\(/);
});

test('web results are untouched', () => {
  const r = { title: 'Page', url: 'https://example.com', content: 'text' };
  assert.equal(enrich(r), r);
});

test('paper gets authors, year, venue, doi prefix; ranking text stays original', () => {
  const out = enrich({ title: 'T', url: 'https://aclanthology.org/x', authors: ['A One', 'B Two', 'C Three', 'D Four'], publishedDate: '2025-10-07T00:00:00', journal: 'ACL', doi: '10.1/x', content: 'abstract' });
  assert.equal(out.content, '[A One, B Two, C Three et al. | 2025 | ACL | doi:10.1/x] abstract');
  assert.equal(out.fane_text, 'abstract');
});

test('arXiv results are flagged as preprints', () => {
  const out = enrich({ title: 'T', url: 'https://arxiv.org/abs/2511.10696', authors: ['Liu'], publishedDate: '2025-11-12', content: 'abs' });
  assert.match(out.content, /\| preprint \(arXiv\)\]/);
});

test('paywalled publisher URL swaps to the arXiv abstract page', () => {
  const out = enrich({ title: 'T', url: 'https://www.sciencedirect.com/science/article/x', pdf_url: 'https://arxiv.org/pdf/2510.05554v2', authors: ['A'], journal: 'NN' });
  assert.equal(out.url, 'https://arxiv.org/abs/2510.05554');
  assert.doesNotMatch(out.content, /preprint/); // has a journal, so not flagged
});

test('open publisher URL is kept even with an arXiv copy', () => {
  const out = enrich({ title: 'T', url: 'https://aclanthology.org/x', pdf_url: 'https://arxiv.org/pdf/2510.05554', authors: ['A'] });
  assert.equal(out.url, 'https://aclanthology.org/x');
});

test('title-only result (crossref) falls back to title', () => {
  const out = enrich({ title: 'Only title', url: 'https://www.ssrn.com/abstract=1', authors: [' Elan '], doi: '10.2139/ssrn.1' });
  assert.equal(out.content, '[Elan | doi:10.2139/ssrn.1] Only title');
  assert.equal(out.fane_text, 'Only title');
});
