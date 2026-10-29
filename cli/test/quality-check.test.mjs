import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { citedSentences, checkPrompt, applyVerdicts, checkAnswer, checkNote, MAX_CLAIMS } from '../write/quality-check.mjs';

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

test('checkAnswer: one call, the web answer ends with the counts; a failed call or reply leaves the answer as written', async () => {
  const calls = [];
  const llm = (content) => ({ generateText: async (input) => { calls.push(input); if (content instanceof Error) throw content; return { content }; } });
  const quiet = () => {};
  const web = await checkAnswer(ANSWER, { sources, web: true, log: quiet, llm: llm('```json\n{"claims":[{"id":2,"verdict":"unsupported","fix":""}]}\n```') });
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
  assert.equal(checkNote({ checked: MAX_CLAIMS, total: 52, corrected: 2, removed: 1 }), `Checked the first ${MAX_CLAIMS} of 52 cited sentences against their sources: 2 corrected, 1 removed.`);
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
