import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { citedSentences, checkPrompt, applyVerdicts, checkAnswer, checkNote, MAX_CLAIMS, SOURCE_BUDGET, SOURCE_MAX } from '../write/quality-check.mjs';

const require = createRequire(import.meta.url);
const { planPatch } = require('../../patches/lib/apply-targets.js');

const ANSWER = `## Node.js

Node.js 24 is the active LTS line.[1] It was released in May 2025.[2] Node is fast.

- Support runs until April 2028.[1][3]
- Uncited bullet here.

| Version | End |
| 24 | 2028 [1] |

\`\`\`js
const x = a[1];
\`\`\``;
const sources = [1, 2, 3].map(n => ({ content: `text of source ${n}`, metadata: { title: `Source ${n}`, url: `https://s${n}.example` } }));

test('cited sentences: prose and list items with their source numbers; headings, tables, code and uncited text left out', () => {
  assert.deepEqual(citedSentences(ANSWER), [
    { text: 'Node.js 24 is the active LTS line.[1]', cites: [1] },
    { text: 'It was released in May 2025.[2]', cites: [2] },
    { text: 'Support runs until April 2028.[1][3]', cites: [1, 3] },
  ]);
  assert.deepEqual(citedSentences('Two sources agree [1, 4]. Greek: Η Αθήνα είναι πρωτεύουσα [2].').map(c => c.cites), [[1, 4], [2]]);
});

test('the prompt holds only the cited sources, numbered as the answer cites them, and marks them untrusted', () => {
  const [system, user] = checkPrompt(citedSentences(ANSWER), sources);
  assert.match(system.content, /untrusted/);
  assert.match(user.content, /\[1\] Source 1\ntext of source 1/);
  assert.match(user.content, /\[3\] Source 3/);
  assert.match(user.content, /1\. Node\.js 24 is the active LTS line\.\[1\]/);
  assert.match(checkPrompt([{ text: 'x [9]', cites: [9] }], sources)[1].content, /^<sources>\n\n<\/sources>/); // no such source
});

test('verdicts: "partly" takes the fix, "unsupported" without a cited fix is removed, a removed bullet leaves no marker', () => {
  const claims = citedSentences(ANSWER);
  const r = applyVerdicts(ANSWER, claims, { claims: [
    { id: 1, verdict: 'supported' },
    { id: 2, verdict: 'partly', fix: 'It was released in April 2025.[2]' },
    { id: 3, verdict: 'unsupported', fix: 'Support runs until 2028.' }, // no citation: removed, not kept uncited
  ] });
  assert.deepEqual([r.corrected, r.removed, r.error], [1, 1, '']);
  assert.match(r.answer, /active LTS line\.\[1\] It was released in April 2025\.\[2\] Node is fast\./);
  assert.doesNotMatch(r.answer, /April 2028|^- *$/m);
  assert.match(r.answer, /- Uncited bullet here\./);
  assert.match(r.answer, /\| 24 \| 2028 \[1\] \|/); // tables untouched
  assert.equal(applyVerdicts(ANSWER, claims, null).error, 'unreadable reply');
  assert.equal(applyVerdicts(ANSWER, claims, null).answer, ANSWER);
});

test('removing a sentence never reflows code or nested lists', () => {
  const answer = [
    'Intro.[1]  Gone claim.[2] Kept claim.[1]',
    '',
    '- item  one',
    '    - nested item stays indented',
    '- Gone bullet.[2]',
    '',
    '```python',
    'def f():',
    '    x  =  1',
    '',
    '',
    '',
    '    return x',
    '-',
    '```',
    '',
    'Use `a  b` here.[1]',
  ].join('\n');
  const claims = citedSentences(answer);
  const r = applyVerdicts(answer, claims, { claims: claims.map((c, i) => ({ id: i + 1, verdict: /Gone/.test(c.text) ? 'unsupported' : 'supported' })) });
  assert.equal(r.removed, 2);
  assert.match(r.answer, /^Intro\.\[1\] Kept claim\.\[1\]\n/);
  assert.ok(r.answer.includes('    - nested item stays indented\n'));
  assert.ok(r.answer.includes('def f():\n    x  =  1\n\n\n\n    return x\n-\n```'));
  assert.ok(r.answer.includes('Use `a  b` here.[1]'));
  assert.doesNotMatch(r.answer, /Gone/);
  assert.doesNotMatch(r.answer.split('```')[0], /^- *$/m);
});

test('verdicts are read once, forgivingly, and counted from what really changed', () => {
  const claims = citedSentences(ANSWER);
  const none = applyVerdicts(ANSWER, claims, { claims: [] });
  assert.deepEqual([none.error, none.checked, none.answer], ['unreadable reply', 0, ANSWER]); // nothing judged is not "all supported"
  assert.equal(applyVerdicts(ANSWER, claims, { claims: [{ id: 9, verdict: 'supported' }, { id: 1, verdict: 'fine' }] }).error, 'unreadable reply');
  const r = applyVerdicts(ANSWER, claims, { claims: [
    { id: 2, verdict: ' Unsupported ' }, { id: '2', verdict: 'supported' }, // the first verdict for a claim counts
    { id: 1, verdict: 'Partially', fix: 'Node.js 24 is an LTS line.[1]' },
  ] });
  assert.deepEqual([r.corrected, r.removed, r.checked, r.total], [1, 1, 2, 3]);
  assert.match(r.answer, /Node\.js 24 is an LTS line\.\[1\]/);
  // a claim whose sentence is no longer in the text (an earlier fix replaced it) is not counted as changed
  const twice = applyVerdicts('Same.[1] Other.[2]', [{ text: 'Same.[1]', cites: [1] }, { text: 'Same.[1]', cites: [1] }], { claims: [
    { id: 1, verdict: 'unsupported' }, { id: 2, verdict: 'unsupported' } ] });
  assert.deepEqual([twice.removed, twice.checked], [1, 2]);
  assert.equal(checkNote({ checked: 2, total: 4, corrected: 0, removed: 0 }), 'Checked 2 of 4 cited sentences against their sources: all supported.');
});

test('the prompt shares one budget between the cited sources, so a fact late in a long page is still read', () => {
  const long = { content: 'x'.repeat(3000) + 'THE FACT' + 'y'.repeat(20000), metadata: { title: 'Long' } };
  const prompt = (n) => checkPrompt(Array.from({ length: n }, (_, i) => ({ text: `claim ${i + 1}[${i + 1}]`, cites: [i + 1] })), Array.from({ length: n }, () => long))[1].content;
  assert.match(prompt(1), /THE FACT/);
  assert.ok(prompt(1).length < SOURCE_MAX + 1000);
  assert.ok(prompt(20).length < SOURCE_BUDGET + 3000); // 20 sources: 3000 characters each, not 20 x 8000
  assert.match(prompt(20), /\[20\] Long/);
});

test('a check that never answers ends at the time limit and shows the answer as written', async () => {
  const never = { generateText: () => new Promise(() => {}) };
  const started = Date.now();
  const web = await checkAnswer(ANSWER, { sources, web: true, log: () => {}, llm: never, timeoutMs: 20 });
  assert.ok(Date.now() - started < 2000);
  assert.ok(web.startsWith(ANSWER));
  assert.match(web, /not checked against its sources \(the check timed out\)/);
  assert.equal(await checkAnswer(ANSWER, { sources, log: () => {}, llm: never, timeoutMs: 20 }), ANSWER);
});

test('checkAnswer: one call, the web answer ends with the counts; a failed call or reply leaves the answer as written', async () => {
  const calls = [];
  const llm = (content) => ({ generateText: async (input) => { calls.push(input); if (content instanceof Error) throw content; return { content }; } });
  const quiet = () => {};
  const web = await checkAnswer(ANSWER, { sources, web: true, log: quiet, llm: llm('```json\n{"claims":[{"id":1,"verdict":"supported"},{"id":2,"verdict":"unsupported","fix":""},{"id":3,"verdict":"supported"}]}\n```') });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(web, /May 2025/);
  assert.match(web, /<p role="status"[^>]*>Checked 3 cited sentences against their sources: 0 corrected, 1 removed\.<\/p>$/);
  const api = await checkAnswer(ANSWER, { sources, log: quiet, llm: llm('{"claims":[]}') });
  assert.equal(api, ANSWER);
  assert.equal(await checkAnswer(ANSWER, { sources, log: quiet, llm: llm(new Error('timeout')) }), ANSWER);
  assert.match(await checkAnswer(ANSWER, { sources, web: true, log: quiet, llm: llm('no json') }), /not checked against its sources \(unreadable reply\)/);
  assert.equal(await checkAnswer('No citations here.', { sources, llm: llm(new Error('not called')) }), 'No citations here.');
  assert.equal(calls.length, 4);
});

test('the note: counts, a capped check, Greek', () => {
  assert.equal(checkNote({ checked: 12, total: 12, corrected: 0, removed: 0 }), 'Checked 12 cited sentences against their sources: all supported.');
  assert.equal(checkNote({ checked: MAX_CLAIMS, total: 52, corrected: 2, removed: 1 }), `Checked ${MAX_CLAIMS} of 52 cited sentences against their sources: 2 corrected, 1 removed.`);
  assert.match(checkNote({ checked: 5, total: 5, corrected: 1, removed: 0 }, 'el'), /^Ελέγχθηκαν 5 προτάσεις με παραπομπή: 1 διορθώθηκαν, 0 αφαιρέθηκαν\.$/);
});

test('patch-quality-check: Speed and Balanced stream as before; Quality collects the answer and shows it as written when the check is missing', async () => {
  const { TARGETS } = require('../../patches/patch-quality-check.js');
  const chat = TARGETS.find(t => t.file.endsWith('chat/route.js'));
  const fake = `var go=async(b,o,s)=>{let ${chat.from}let out=[];for await(let c of t)out.push(c.contentChunk);return out};`;
  const r = planPatch({ [chat.file]: fake }, [chat]);
  assert.deepEqual([r.errors, planPatch(r.next, [chat]).applied], [[], []]);
  const go = new Function('console', `${r.next[chat.file]}return go`)({ log() {} });
  const input = (mode) => ({ config: { mode, llm: { streamText: async function* () { yield { contentChunk: 'Hello ' }; yield { contentChunk: 'world.' }; } } }, chatHistory: [], followUp: 'q' });
  assert.deepEqual(await go(input('balanced'), null, 'sys'), ['Hello ', 'world.']);
  assert.deepEqual(await go(input('quality'), { searchFindings: [] }, 'sys'), ['Hello world.']); // /fane/write is not here: unchecked
});
