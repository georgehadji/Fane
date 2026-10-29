import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, mapProse, mapOutsideFences, withoutFences } from '../core/markdown.mjs';

const kinds = (t) => segments(t).map(s => `${s.fenced ? 'fence' : s.code ? 'span' : 'prose'}:${s.text}`);

test('segments join back to the input, whatever the fences look like', () => {
  for (const t of ['', 'plain', 'a `b` c', '```js\nx\n```\nafter', '~~~\nopen fence never closed', '````\n```\ninner\n```\n````\n', 'a ``x ` y`` b', 'no newline at end ```\nx']) {
    assert.equal(segments(t).map(s => s.text).join(''), t, JSON.stringify(t));
  }
});

test('fenced blocks: ``` and ~~~, closed by the same character and at least the same length, or by the end', () => {
  assert.deepEqual(kinds('before\n```js\ncode\n```\nafter'), ['prose:before\n', 'fence:```js\ncode\n```\n', 'prose:after']);
  assert.deepEqual(kinds('~~~\n```\nnot a close\n~~~\nx'), ['fence:~~~\n```\nnot a close\n~~~\n', 'prose:x']);
  assert.deepEqual(kinds('````\n```\ninner\n```\n````\ntext'), ['fence:````\n```\ninner\n```\n````\n', 'prose:text']);
  assert.deepEqual(kinds('text\n```\nnever closed\nstill code'), ['prose:text\n', 'fence:```\nnever closed\nstill code']);
});

test('inline code spans: a backtick run closed by a run of the same length', () => {
  assert.deepEqual(kinds('use `Promise<string>` here'), ['prose:use ', 'span:`Promise<string>`', 'prose: here']);
  assert.deepEqual(kinds('a ``x ` y`` b'), ['prose:a ', 'span:``x ` y``', 'prose: b']);
  assert.deepEqual(kinds('a lone ` backtick'), ['prose:a lone ` backtick']);
  assert.deepEqual(kinds('```x``` is a span'), ['span:```x```', 'prose: is a span']); // not a fence: backticks in the info string
});

test('mapProse changes prose only; mapOutsideFences changes everything but fenced blocks', () => {
  const t = 'a  b `c  d`\n```\ne  f\n```\ng  h';
  assert.equal(mapProse(t, s => s.replace(/ {2}/g, '_')), 'a_b `c  d`\n```\ne  f\n```\ng_h');
  assert.equal(mapOutsideFences(t, s => s.replace(/ {2}/g, '_')), 'a_b `c_d`\n```\ne  f\n```\ng_h');
  assert.equal(withoutFences(t), 'a  b `c  d`\ng  h');
});
