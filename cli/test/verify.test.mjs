import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { verifyCitations, splitSentences, tokenize, parseCli } = await import('../vane.mjs');

const sources = [
  { title: 'Node.js releases', content: 'Node.js 24 Krypton entered Active LTS in October 2025 and is supported until April 2028.' },
  { title: 'Laptop guide', content: 'The Acer Aspire 5 costs about $549 and has 16 GB of RAM and a 512 GB SSD.' },
];

test('splitSentences: headings, list markers, tables, abbreviations', () => {
  const md = '## Summary\n- First point about releases[1].\n| Model | Price |\n|---|---|\n| Aspire | $549 [2] |\nChen et al. (2025) show gains[1]. Second sentence here[2].';
  assert.deepEqual(splitSentences(md), ['First point about releases[1].', '| Model | Price |', '| Aspire | $549 [2] |', 'Chen et al. (2025) show gains[1].', 'Second sentence here[2].']);
});

test('tokenize drops stop words and short words, stems plurals', () => {
  assert.deepEqual([...tokenize('The laptops are with 16 GB')].sort(), ['laptop']);
});

test('supported sentence: words and numbers found in the cited source', () => {
  const v = verifyCitations('Node.js 24 Krypton entered Active LTS in October 2025 and is supported until April 2028[1].', sources);
  assert.equal(v.cited, 1);
  assert.equal(v.supported, 1);
  assert.equal(v.supportRate, 1);
});

test('citing the wrong source is weak', () => {
  const v = verifyCitations('Node.js 24 Krypton entered Active LTS in October 2025 and is supported until April 2028[2].', sources);
  assert.equal(v.supported, 0);
  assert.equal(v.weak.length, 1);
});

test('number not in the cited source is flagged even when the words match', () => {
  const v = verifyCitations('The Acer Aspire 5 costs about $649 and has 16 GB of RAM and a 512 GB SSD[2].', sources);
  assert.equal(v.supported, 0);
  assert.deepEqual(v.numbersMissing[0].numbers, ['649']);
});

test('thousands separators match', () => {
  const v = verifyCitations('Sales reached 1,250 units in the reported quarter for the company[1].', [{ title: '', content: 'sales reached 1250 units in the reported quarter for the company' }]);
  assert.equal(v.supported, 1);
});

test('citation number without a source is reported', () => {
  const v = verifyCitations('Node.js 24 Krypton entered Active LTS in October 2025[1][9].', sources);
  assert.deepEqual(v.invalidCitations[0].cites, [9]);
});

test('uncited sentences are counted but do not change the rate; short fragments are ignored', () => {
  const v = verifyCitations('This framing sentence summarises results without giving any citation. Node.js 24 Krypton entered Active LTS in October 2025[1]. Short one.', sources);
  assert.equal(v.uncited, 1);
  assert.equal(v.sentences, 2);
  assert.equal(v.supportRate, 1);
});

test('no cited sentences gives a null rate', () => {
  assert.equal(verifyCitations('Nothing here is cited in any way whatsoever.', sources).supportRate, null);
});

test('--min-support validates and implies --verify', () => {
  const o = parseCli(['q', '--min-support', '0.8']);
  assert.equal(o.verify, true);
  assert.equal(o['min-support'], 0.8);
  assert.throws(() => parseCli(['q', '--min-support', '2']), /Invalid --min-support/);
});
