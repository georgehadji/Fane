// patch-summary-cite: the Synopsis paragraph of a one-source summary carries [1] (patches/patch-summary-cite.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planPatch } = require('../../patches/lib/apply-targets.js');
const { FILES, SUMMARY_QUESTION } = require('../../patches/lib/vane.js');
const { ASK } = require('../../patches/patch-discover-summary-greek.js');
const { TARGETS, CITE_SUMMARY } = require('../../patches/patch-summary-cite.js');

const Q = `${ASK}A title\nhttps://example.com/story`;
const SYN = '\u03a3\u03cd\u03bd\u03bf\u03c8\u03b7';
const KEY = '\u0392\u03b1\u03c3\u03b9\u03ba\u03ac \u03c3\u03b7\u03bc\u03b5\u03af\u03b1';
const ANSWER = `## ${SYN}\n\u039c\u03b9\u03b1 \u03c0\u03c1\u03cc\u03c4\u03b1\u03c3\u03b7. \u0394\u03b5\u03cd\u03c4\u03b5\u03c1\u03b7.\n\n## ${KEY}\n- \u03ad\u03bd\u03b1\n- \u03b4\u03cd\u03bf\n\n\u03a0\u03b7\u03b3\u03ae: example.com`;
const cite = (t, q = Q, n = 1) => CITE_SUMMARY(t, q, n, SUMMARY_QUESTION);
const NO_QUERY = null; // (undefined would pick the default)

test('the complete Synopsis paragraph of a one-source summary gets [1] at its end, and nothing else changes', () => {
  const out = cite(ANSWER);
  assert.equal(out, ANSWER.replace('\u0394\u03b5\u03cd\u03c4\u03b5\u03c1\u03b7.\n', '\u0394\u03b5\u03cd\u03c4\u03b5\u03c1\u03b7. [1]\n'));
  assert.equal(out.length, ANSWER.length + 4);
});

test('idempotent: applying it to its own output changes nothing', () => {
  const once = cite(ANSWER);
  assert.equal(cite(once), once);
});

test('a streaming prefix is left alone until the next heading has arrived (no flicker)', () => {
  const at = ANSWER.indexOf(`## ${KEY}`);
  for (let i = 0; i < at + 3; i++) assert.equal(cite(ANSWER.slice(0, i)), ANSWER.slice(0, i), `prefix ${i}`);
  assert.notEqual(cite(ANSWER.slice(0, at + 3)), ANSWER.slice(0, at + 3));
});

test('a paragraph that cites already is unchanged: [1], [1, 2], [2], and a citation in the middle', () => {
  for (const mark of ['[1]', '[1, 2]', '[2]', '[ 1 ]']) {
    const t = ANSWER.replace('\u0394\u03b5\u03cd\u03c4\u03b5\u03c1\u03b7.', `\u0394\u03b5\u03cd\u03c4\u03b5\u03c1\u03b7. ${mark}`);
    assert.equal(cite(t), t, mark);
  }
  const mid = ANSWER.replace('\u039c\u03b9\u03b1 \u03c0\u03c1\u03cc\u03c4\u03b1\u03c3\u03b7.', '\u039c\u03b9\u03b1 [1] \u03c0\u03c1\u03cc\u03c4\u03b1\u03c3\u03b7.');
  assert.equal(cite(mid), mid);
});

test('two sources, none, or a question that is not a summary never get a citation', () => {
  assert.equal(cite(ANSWER, Q, 2), ANSWER);
  assert.equal(cite(ANSWER, Q, 0), ANSWER);
  assert.equal(cite(ANSWER, 'what is solar power', 1), ANSWER);
  assert.equal(cite(ANSWER, NO_QUERY, 1), ANSWER);
  assert.equal(cite(ANSWER, `Summary: https://example.com/a`, 1), ANSWER);
});

test('no Synopsis heading, an empty paragraph or a non-string: unchanged', () => {
  for (const t of ['Just text.\n\n## Other\nmore', `## ${SYN}\n\n## ${KEY}\nx`, `## ${SYN}`, '', undefined, null]) assert.equal(cite(t), t);
  const crlf = ANSWER.replace(/\n/g, '\r\n');
  assert.match(cite(crlf), /\u0394\u03b5\u03cd\u03c4\u03b5\u03c1\u03b7\. \[1\]\r\n/);
  assert.equal(cite(cite(crlf)), cite(crlf));
});

test('a level 3 heading and the untitled question form work', () => {
  const h3 = ANSWER.replace(`## ${SYN}`, `### ${SYN}`);
  assert.ok(cite(h3).includes('. [1]\n\n## '));
  assert.ok(cite(ANSWER, `${ASK}https://example.com/a`).includes('. [1]\n\n## '));
});

// ---- the patch ----

const BUNDLE = String.raw`const W=(S)=>(0,s.useMemo)(()=>S.map(e=>{let t=[],r="",a=!1,s=[],l=e.responseBlocks.filter(e=>"source"===e.type).flatMap(e=>e.data),d=1;return e.responseBlocks.forEach(e=>{if("text"===e.type){let s=e.data,d=/\[(\d+)\]/g;t.push(s)}}),{message:e,parsedTextBlocks:t}}),[S]);`;

test('patch-summary-cite: applies once, twice is a no-op, both targets are in the chat chunk, injected code is ASCII without backticks', () => {
  const one = planPatch({ [FILES.chatClient]: BUNDLE }, TARGETS);
  assert.deepEqual([one.errors, one.applied.length], [[], 2]);
  assert.deepEqual(planPatch(one.next, TARGETS).applied, []);
  assert.ok(TARGETS.every(t => t.file === FILES.chatClient));
  for (const t of TARGETS) { assert.ok(/^[\x20-\x7e\n]*$/.test(t.to.replace(/\r/g, ''))); assert.ok(!t.to.includes('`')); }
});

test('patch-summary-cite: the patched chunk cites a summary and leaves other chats alone (run against a stub React)', () => {
  const patched = planPatch({ [FILES.chatClient]: BUNDLE }, TARGETS).next[FILES.chatClient];
  const run = new Function('s', `${patched};return W`)({ useMemo: (f) => f() });
  const msg = (query, text, sources) => ({ query, responseBlocks: [{ type: 'source', data: sources }, { type: 'text', data: text }] });
  const one = [{ metadata: { url: 'https://example.com/story' } }];
  assert.match(run([msg(Q, ANSWER, one)])[0].parsedTextBlocks[0], /\[1\]\n\n## /);
  assert.equal(run([msg('what is x', ANSWER, one)])[0].parsedTextBlocks[0], ANSWER);
  assert.equal(run([msg(Q, ANSWER, [...one, ...one])])[0].parsedTextBlocks[0], ANSWER);
});
