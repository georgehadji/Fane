// Tests the snippet-ranking code patches/patch-web-search.js injects into Vane's quality
// mode. Imported from the patch module, so the test runs exactly what ends up in the bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { RANK, STRIP } = createRequire(import.meta.url)('../../patches/patch-web-search.js');
const rank = eval(RANK);
const strip = eval(STRIP);

const snip = (url) => ({ content: url, metadata: { url } });

test('keeps candidates above 0.5 similarity, best first', () => {
  const C = [snip('far'), snip('close'), snip('mid')];
  // one query [1,0]; candidates at cos 0, 1, ~0.71
  const V = [[1, 0], [0, 1], [1, 0], [1, 1]];
  assert.deepEqual(rank(C, V, 1).map(x => x.metadata.url), ['close', 'mid']);
});

test('uses the best-matching query for each candidate', () => {
  const C = [snip('a'), snip('b')];
  const V = [[1, 0], [0, 1], [0, 1], [1, 0]]; // two queries; each candidate matches one
  assert.equal(rank(C, V, 2).length, 2);
});

test('caps at 8 results', () => {
  const C = Array.from({ length: 12 }, (_, k) => snip(String(k)));
  const V = [[1, 0], ...C.map(() => [1, 0])];
  assert.equal(rank(C, V, 1).length, 8);
});

test('zero vectors do not crash and are dropped', () => {
  assert.deepEqual(rank([snip('z')], [[1, 0], [0, 0]], 1), []);
});

test('strip removes the metadata prefix other patches add', () => {
  assert.equal(strip({ content: '[Hacker News | 2025-03-14] comment text' }), 'comment text');
  assert.equal(strip({ content: '[A, B | 2025 | ACL] abstract' }), 'abstract');
  assert.equal(strip({ content: 'plain [1] snippet' }), 'plain [1] snippet');
  assert.equal(strip({}), '');
});
