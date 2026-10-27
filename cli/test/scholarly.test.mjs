// Tests the paper-enrichment function that patches/patch-scholarly-sources.js injects
// into Vane's SearXNG client. Imported from the patch module, so the test runs exactly
// the code that ends up in the bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const enrich = eval(createRequire(import.meta.url)('../../patches/patch-scholarly-sources.js').ENRICH);

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
