import { test } from 'node:test';
import assert from 'node:assert/strict';

const { median, measure, aggregate, compare } = await import('../../scripts/bench.mjs');

test('median ignores nulls', () => {
  assert.equal(median([3, null, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null]), null);
});

test('measure: counts, hosts, citations, non-Latin titles', () => {
  const m = measure({
    message: 'One two three[1]. Four[2][1].',
    sources: [{ title: 'A', url: 'https://www.a.com/x' }, { title: 'Ελληνικά', url: 'https://b.gr/' }, { title: 'C', url: 'https://a.com/y' }],
    verification: { supportRate: 0.5, weak: [{}], numbersMissing: [], invalidCitations: [], uncited: 2 },
  });
  assert.deepEqual(m, { words: 4, sources: 3, hosts: 2, citesUsed: 2, supportRate: 0.5, weak: 1, numbersMissing: 0, invalidCitations: 0, uncited: 2, nonLatin: 0.333 });
});

test('aggregate: medians per question/mode, failed runs excluded', () => {
  const s = aggregate([
    { id: 'q', mode: 'speed', secs: 10, sources: 10 },
    { id: 'q', mode: 'speed', secs: 30, sources: 20 },
    { id: 'q', mode: 'speed', error: 'timeout', secs: 999 },
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].secs, 20);
  assert.equal(s[0].failed, 1);
  assert.equal(s[0].runs, 3);
});

test('compare flags regressions past the tolerances only', () => {
  const base = [{ id: 'q', mode: 'speed', failed: 0, sources: 20, supportRate: 0.9, secs: 20, nonLatin: 0 }];
  assert.deepEqual(compare(base, [{ ...base[0], sources: 16, supportRate: 0.85, secs: 29 }]).regressions, []);
  const r = compare(base, [{ ...base[0], failed: 1, sources: 10, supportRate: 0.7, secs: 40, nonLatin: 0.2 }]).regressions;
  assert.equal(r.length, 5);
});

test('compare skips questions missing from the baseline', () => {
  assert.deepEqual(compare([], [{ id: 'new', mode: 'speed' }]), { rows: [], regressions: [] });
});
