// The shared patch engine (patches/lib/apply-targets.js) and the patch definitions it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { planPatch, isApplied } = require('../../patches/lib/apply-targets.js');
const { FILES } = require('../../patches/lib/vane.js');

const F = '/x/bundle.js';
const T = (o) => ({ name: 't', file: F, ...o });

test('applies a target once; re-running is a no-op', () => {
  const t = T({ from: 'a=1', to: 'a=2' });
  const one = planPatch({ [F]: 'var a=1;' }, [t]);
  assert.deepEqual([one.errors, one.applied, one.next[F]], [[], ['t'], 'var a=2;']);
  const two = planPatch(one.next, [t]);
  assert.deepEqual([two.errors, two.applied, two.next[F]], [[], [], 'var a=2;']);
});

test('a marker proves a target applied after a later patch edited its output', () => {
  const t = T({ from: 'a=1', to: 'a=2/*m*/', marker: '/*m*/' });
  assert.ok(isApplied('var a=3/*m*/;', t));
  assert.deepEqual(planPatch({ [F]: 'var a=3/*m*/;' }, [t]).errors, []);
});

test('alternatives: the first from that matches exactly once is used', () => {
  const t = T({ alts: [{ from: 'x()', to: 'X()' }, { from: 'y()', to: 'Y()' }] });
  assert.equal(planPatch({ [F]: 'y();' }, [t]).next[F], 'Y();');
});

test('all or nothing: one bad target means no changes at all', () => {
  const r = planPatch({ [F]: 'var a=1;' }, [T({ name: 'ok', from: 'a=1', to: 'a=2' }), T({ name: 'bad', from: 'nope', to: 'x' })]);
  assert.deepEqual(r.errors, ['bad: expected 1 match, found 0']);
  assert.equal(r.next[F], 'var a=2;'); // planned only; run() writes nothing when errors exist
  assert.ok(planPatch({ [F]: 'a=1;a=1;' }, [T({ from: 'a=1', to: 'a=2' })]).errors[0].includes('found 2'));
});

test('optional targets are skipped, not failed, when absent', () => {
  const r = planPatch({ [F]: 'var a=1;' }, [T({ from: 'zzz', to: 'q', optional: 'needs other patch' })]);
  assert.deepEqual([r.errors, r.skipped], [[], ['t (needs other patch)']]);
});

test('a patched bundle that does not parse is refused', () => {
  const r = planPatch({ [F]: 'var a=1;' }, [T({ from: 'a=1', to: 'a=(' })]);
  assert.match(r.errors[0], /does not parse/);
});

test('every patch declares well-formed targets on known Vane files', () => {
  const dir = new URL('../../patches/', import.meta.url);
  const known = new Set(Object.values(FILES));
  const names = new Set();
  for (const f of readdirSync(dir).filter(x => /^patch-.*\.js$/.test(x))) {
    const { TARGETS } = require(`../../patches/${f}`);
    assert.ok(Array.isArray(TARGETS) && TARGETS.length, f);
    for (const t of TARGETS) {
      assert.ok(known.has(t.file), `${f}: ${t.name} has unknown file ${t.file}`);
      for (const a of t.alts || [{ from: t.from, to: t.to }]) {
        assert.ok(a.from && a.to && a.from !== a.to, `${f}: ${t.name}`);
        assert.ok(!a.from.includes(a.to), `${f}: ${t.name}: to is inside from, so it would always look applied`);
      }
      names.add(`${f}:${t.name}`);
    }
  }
  assert.ok(names.size >= 27);
});
