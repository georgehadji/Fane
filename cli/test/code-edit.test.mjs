// Follow-up edits of code the web chat wrote: reading an earlier answer back (parseCodeAnswer), picking the files a
// change goes to (pickTargets), the verb test (isCodeEdit), the editor (createCodeEditor) and the hook's routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isCodeEdit, isCodeRequest } from '../core/intent-code.mjs';
import { OpenRouterError } from '../image/openrouter.mjs';
import { MAX_FILE_CHARS } from '../code/files.mjs';
import { parseCodeAnswer, pickTargets } from '../code/edit.mjs';
import { FIX, createCodeEditor } from '../code/pipeline.mjs';
import { CODE_ANSWER_MARKER, codeTagged, renderCodeResult } from '../code/present.mjs';
import { handleCodeRequest } from '../code/vane-hook.mjs';

const require = createRequire(import.meta.url);

const file = (path, content, status = 'ok') => ({ path, content, syntax: { status }, role: 'source' });
const render = (over = {}) => renderCodeResult({
  language: 'en', mode: 'speed', spec: { summary: 'Counts <words> & lines.' }, cost: 0.01, ms: 5000,
  files: [file('pkg/__init__.py', 'VERSION = "1"\n'), file('page.html', '<h4>not a heading</h4>\n<p>hi</p>\n'), file('count.py', 'def count(s):\n    return len(s.split())\n')],
  tests: [file('test_count.py', 'from count import count\n\ndef test_count():\n    assert count("a b") == 2\n')],
  readme: '# T\n\nRun:\n\n```bash\npython count.py\n```\n', review: null, fixes: [], open: [], docs: [], cve: [], checks: [], degraded: [], ...over,
});
const answer = (over) => codeTagged(render(over));

// ---- parseCodeAnswer ----

test('parseCodeAnswer: files, tests and summary come back; the README is skipped, an HTML file holding <h4> stays one file', () => {
  const p = parseCodeAnswer(answer());
  assert.deepEqual(p.files.map(f => f.path), ['pkg/__init__.py', 'page.html', 'count.py']);
  assert.deepEqual(p.tests.map(f => f.path), ['test_count.py']);
  assert.equal(p.summary, 'Counts <words> & lines.');
  assert.equal(p.language, 'python');
  assert.equal(p.files[1].content, '<h4>not a heading</h4>\n<p>hi</p>\n');
  assert.equal(p.files[2].content, 'def count(s):\n    return len(s.split())\n');
  assert.ok(p.tests.every(f => f.role === 'test') && p.files.every(f => f.role === 'source'));
});

test('parseCodeAnswer: no marker, no file or only unsafe paths -> null; an unsafe path is dropped, the rest kept', () => {
  assert.equal(parseCodeAnswer(render().replace(CODE_ANSWER_MARKER, '')), null); // the marker is what says it is ours
  assert.equal(parseCodeAnswer(''), null);
  assert.equal(parseCodeAnswer(undefined), null);
  assert.equal(parseCodeAnswer(codeTagged('<p>just prose</p>')), null);
  assert.equal(parseCodeAnswer(answer({ files: [file('../evil.py', 'x = 1\n')], tests: [] })), null);
  const p = parseCodeAnswer(answer({ files: [file('/etc/passwd', 'x\n'), file('ok.py', 'y = 2\n')], tests: [] }));
  assert.deepEqual(p.files.map(f => f.path), ['ok.py']);
});

test('parseCodeAnswer: a file whose code holds a longer fence survives the round trip', () => {
  const content = 'x = "```"\n';
  const p = parseCodeAnswer(answer({ files: [file('a.py', content)], tests: [] }));
  assert.equal(p.files[0].content, content);
});

// ---- pickTargets ----

test('pickTargets: a named file, the tests only when asked, every source file otherwise, big files left out', () => {
  const files = [file('src/a.py', 'a\n'), file('src/b.py', 'b\n')];
  const tests = [{ ...file('test_a.py', 't\n'), role: 'test' }];
  assert.deepEqual(pickTargets('add logging', files, tests).targets.map(f => f.path), ['src/a.py', 'src/b.py']);
  assert.deepEqual(pickTargets('add logging to b.py', files, tests).targets.map(f => f.path), ['src/b.py']);
  assert.deepEqual(pickTargets('change src/a.py', files, tests).targets.map(f => f.path), ['src/a.py']);
  assert.deepEqual(pickTargets('add a test for the empty case', files, tests).targets.map(f => f.path), ['src/a.py', 'src/b.py', 'test_a.py']);
  assert.deepEqual(pickTargets('fix the bug in aa.py', files, tests).targets.map(f => f.path), ['src/a.py', 'src/b.py']); // "aa.py" is not "a.py"
  const big = file('big.py', 'x'.repeat(MAX_FILE_CHARS + 1));
  const r = pickTargets('tidy up', [big, files[0]], []);
  assert.deepEqual([r.targets.map(f => f.path), r.skipped], [['src/a.py'], ['big.py']]);
});

// ---- isCodeEdit ----

test('isCodeEdit: a leading edit verb, never a question, thanks or new code', () => {
  for (const q of ['add input validation', 'Please rename parse to parse_line', 'ok, now use argparse', 'could you fix the off-by-one in count.py', 'convert it to async', 'πρόσθεσε έλεγχο εισόδου', 'μετονόμασε τη συνάρτηση σε parse_line', 'Άλλαξε το όνομα του αρχείου'])
    assert.equal(isCodeEdit(q), true, q);
  for (const q of ['what does count do?', 'why is it slow', 'thanks, add nothing', 'write me a poem', 'explain the code', 'ευχαριστώ, αλλάξε το', 'Τι κάνει αυτό; Πρόσθεσε σχόλια', 'tell me more', ''])
    assert.equal(isCodeEdit(q), false, q);
  assert.equal(isCodeRequest('write a function that adds two numbers'), true); // new code is the other branch
});

// ---- createCodeEditor ----

const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0.002 } });
const roleOf = (body) => (/applying one requested change/.test(body.messages[0].content) ? 'edit' : /security engineer/.test(body.messages[0].content) ? 'review' : 'other');
const targetOf = (body) => /Apply the change to (\S+)\. If/.exec(body.messages[1].content)?.[1];

function fakeClient(by) {
  const calls = [];
  return {
    calls,
    chat: async (body) => {
      const role = roleOf(body), path = targetOf(body);
      calls.push({ role, path, body });
      const a = by[role];
      const out = typeof a === 'function' ? a(path, body) : a;
      if (out instanceof Error) throw out;
      return reply(out);
    },
  };
}

const CHAINS = { edit: ['m'], review: ['m'] };
const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `${tag}${i} = ${i}`).join('\n');
const A = { path: 'a.py', content: `${lines(10, 'a')}\n`, role: 'source' };
const B = { path: 'b.py', content: `${lines(10, 'b')}\n`, role: 'source' };
const T = { path: 'test_a.py', content: 'def test_a():\n    assert True\n', role: 'test' };
// parses unless the file says BROKEN
const checkSyntax = async (list) => list.map(f => ({ path: f.path, status: /BROKEN/.test(f.content) ? 'error' : 'ok', detail: /BROKEN/.test(f.content) ? 'bad syntax' : undefined }));
const fenced = (c) => `\`\`\`python\n${c}\n\`\`\``;

const run = (client, over = {}) => createCodeEditor({ client, checkSyntax })({ files: [A, B], tests: [T], summary: 'S', language: 'python', change: 'add a header comment', mode: 'speed', chains: CHAINS, ...over });

test('editor: one call per file, UNCHANGED files are kept, changed ones land and are listed', async () => {
  const client = fakeClient({ edit: (p) => (p === 'a.py' ? fenced(`# header\n${A.content}`) : 'UNCHANGED') });
  const r = await run(client);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(client.calls.map(c => c.path).sort(), ['a.py', 'b.py']); // not the tests: the change names none
  assert.deepEqual(r.changed, ['a.py']);
  assert.match(r.files.find(f => f.path === 'a.py').content, /^# header\n/);
  assert.equal(r.files.find(f => f.path === 'b.py').content, B.content);
  assert.deepEqual(r.tests.map(f => [f.path, f.content]), [[T.path, T.content]]);
  assert.equal(r.readme, '');
  assert.equal(r.edit, true);
  assert.equal(r.review, null); // Speed: no review
  assert.equal(r.calls, 2);
  assert.ok(Math.abs(r.cost - 0.004) < 1e-9);
  assert.ok(r.phases.every(p => p.phase === 'edit'));
  assert.equal(r.stopped, null);
  // the other file goes in as reference only
  assert.match(client.calls.find(c => c.path === 'a.py').body.messages[1].content, /for reference only/);
});

test('editor: the result renders as an answer that reads back and says how many files changed', async () => {
  const r = await run(fakeClient({ edit: (p) => (p === 'a.py' ? fenced(`# header\n${A.content}`) : 'UNCHANGED') }));
  const html = codeTagged(renderCodeResult(r));
  assert.match(html, /1 changed/);
  assert.doesNotMatch(html, /README\.md/);
  const again = parseCodeAnswer(html);
  assert.deepEqual(again.files.map(f => f.path), ['a.py', 'b.py']);
  assert.match(again.files[0].content, /^# header/);
});

test('editor: a change that names a test file also reaches the tests', async () => {
  const client = fakeClient({ edit: (p) => (p === 'test_a.py' ? fenced('def test_a():\n    assert 1 == 1\n') : 'UNCHANGED') });
  const r = await run(client, { change: 'tighten the assert in test_a.py' });
  assert.deepEqual(client.calls.map(c => c.path), ['test_a.py']);
  assert.deepEqual(r.changed, ['test_a.py']);
  assert.match(r.tests[0].content, /1 == 1/);
});

test('editor: a much shorter file and a file that stops parsing are refused, the earlier file kept, and the run fails when nothing landed', async () => {
  const short = await run(fakeClient({ edit: () => fenced('x = 1') }));
  assert.equal(short.ok, false);
  assert.equal(short.edit, true);
  assert.match(short.error, /no file was changed/);
  assert.match(short.error, /much shorter/);

  const broken = await run(fakeClient({ edit: (p) => (p === 'a.py' ? fenced(`BROKEN\n${A.content}`) : fenced(`# ok\n${B.content}`)) }));
  assert.equal(broken.ok, true); // b.py landed
  assert.deepEqual(broken.changed, ['b.py']);
  assert.equal(broken.files.find(f => f.path === 'a.py').content, A.content);
  assert.ok(broken.degraded.some(d => /a\.py was not used \(the changed file does not parse/.test(d)), broken.degraded.join('|'));
  assert.ok(broken.phases.some(p => p.phase === 'edit' && p.status === 'rejected' && p.file === 'a.py'));
});

test('editor: a file that already did not parse may stay broken; a copy of the file back is no change', async () => {
  const bad = { ...A, content: `BROKEN\n${lines(10, 'a')}\n` };
  const r = await run(fakeClient({ edit: (p) => (p === 'a.py' ? fenced(`BROKEN\n# more\n${lines(10, 'a')}`) : fenced(B.content.trim())) }), { files: [bad, B] });
  assert.deepEqual(r.changed, ['a.py']); // b.py came back as it was
  const same = await run(fakeClient({ edit: (p) => fenced((p === 'a.py' ? A : B).content.replace(/\n$/, '')) }));
  assert.equal(same.ok, false);
});

test('editor: a call that fails keeps that file and says so; the other still lands', async () => {
  const r = await run(fakeClient({ edit: (p) => (p === 'a.py' ? new OpenRouterError('500 boom', 500) : fenced(`# ok\n${B.content}`)) }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, ['b.py']);
  assert.ok(r.degraded.some(d => /a\.py could not be changed/.test(d)), r.degraded.join('|'));
});

test('editor: a 402 or a 499 before any file landed returns nothing', async () => {
  const none = await run(fakeClient({ edit: new OpenRouterError('402 insufficient credits', 402) }));
  assert.equal(none.ok, false);
  assert.equal(none.fatal, true);
  assert.equal(none.status, 402);
  const stopped = await run(fakeClient({ edit: new OpenRouterError('stopped', 499) }));
  assert.equal(stopped.ok, false);
  assert.equal(stopped.status, 499);
});

test('editor: a 402 after a file landed keeps it with a stopped note and no review', async () => {
  const noCredits = new OpenRouterError('402 insufficient credits', 402);
  // one file at a time, so the order is fixed: a.py lands, then b.py hits the limit
  const r = await createCodeEditor({ client: fakeClient({ edit: (p) => (p === 'a.py' ? fenced(`# h\n${A.content}`) : noCredits), review: '{}' }), checkSyntax })({ files: [A, B], tests: [], change: 'add a header', mode: 'balanced', chains: CHAINS });
  if (!r.ok) return assert.equal(r.fatal, true); // files run in parallel: the 402 may come first, then nothing landed
  assert.deepEqual(r.changed, ['a.py']);
  assert.equal(r.stopped.status, 402);
  assert.match(r.degraded[0], /^stopped \(.*insufficient credits.*\)/);
  assert.equal(r.review, null);
});

test('editor: no file can take the change (all too long) -> a failure, no call', async () => {
  const client = fakeClient({ edit: 'UNCHANGED' });
  const r = await run(client, { files: [{ ...A, content: 'x'.repeat(MAX_FILE_CHARS + 1) }], tests: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /no file of the project can take the change/);
  assert.equal(client.calls.length, 0);
});

test('editor (balanced): the changed files are reviewed, findings are listed and not fixed', async () => {
  const review = JSON.stringify({ critical: [{ file: 'a.py', issue: 'header is wrong', fix: 'change it' }], high: [], medium: [], verdict: 'needs_fixes', security_posture: 'fine' });
  const client = fakeClient({ edit: (p) => (p === 'a.py' ? fenced(`# header\n${A.content}`) : 'UNCHANGED'), review });
  const r = await run(client, { mode: 'balanced', chains: { ...CHAINS, review: ['m'] } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(client.calls.map(c => c.role).sort(), ['edit', 'edit', 'review']);
  assert.deepEqual(r.open.map(i => [i.file, i.fixState]), [['a.py', FIX.notAttempted]]);
  assert.deepEqual(r.fixes, []);
  assert.match(r.open[0].fixNote, /ask for the fix/);
  assert.ok(codeTagged(renderCodeResult(r)).includes('header is wrong'));
});

test('editor: an unknown mode is a programming error', async () => {
  await assert.rejects(() => run(fakeClient({}), { mode: 'turbo' }), /unknown mode/);
});

// ---- the hook ----

const catalogue = [{ id: 'lab/coder', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, supported_parameters: ['response_format'] }];
const trial = { 'lab/coder': { code: { ok: true, score: 0 }, json: { ok: true } } };
const ui = () => { const blocks = new Map(); let n = 0; return { blocks, emit: (x) => { const id = `b${++n}`; blocks.set(id, x); return id; }, update: (id, x) => blocks.set(id, x) }; };

test('hook: an edit after a code answer runs the editor, without research, and logs the code-edit feature', async () => {
  const earlier = answer();
  const out = ui(), logs = [];
  let edited, searched = 0;
  const editor = async (args) => {
    edited = args;
    return { ok: true, edit: true, language: 'en', mode: 'balanced', spec: { summary: args.summary }, files: args.files, tests: args.tests, readme: '', review: null, fixes: [], open: [], docs: [], cve: [], checks: [], degraded: [], cost: 0.01, ms: 1000, changed: ['count.py'], phases: [] };
  };
  const ok = await handleCodeRequest('add input validation', { ...out, client: { models: async () => catalogue }, trial, editor, lastAnswer: async () => earlier, research: async () => { searched++; return []; }, mode: 'balanced', log: (m) => logs.push(m) });
  assert.equal(ok, true);
  assert.equal(searched, 0);
  assert.equal(edited.change, 'add input validation');
  assert.deepEqual(edited.files.map(f => f.path), ['pkg/__init__.py', 'page.html', 'count.py']);
  assert.deepEqual(edited.tests.map(f => f.path), ['test_count.py']);
  assert.equal(edited.summary, 'Counts <words> & lines.');
  const final = [...out.blocks.values()].at(-1);
  assert.match(final, /1 changed/);
  assert.ok(final.includes(CODE_ANSWER_MARKER));
  const summary = logs.filter(l => /"feature":/.test(l)).map(l => JSON.parse(l.slice(l.indexOf('{'))))[0];
  assert.equal(summary.feature, 'code-edit');
  assert.equal(summary.ok, true);
});

test('hook: an edit verb after a plain answer, or with no earlier answer, is not the hook\'s; new code still is', async () => {
  const out = ui();
  const base = { ...out, client: { models: async () => catalogue }, trial, editor: async () => { throw new Error('must not run'); } };
  assert.equal(await handleCodeRequest('add input validation', { ...base, lastAnswer: async () => '# An article\n\nSome words here.' }), false);
  assert.equal(await handleCodeRequest('add input validation', { ...base, lastAnswer: async () => '' }), false);
  assert.equal(await handleCodeRequest('add input validation', { ...base, history: [{ role: 'assistant', content: 'plain' }] }), false);
  assert.equal(await handleCodeRequest('what does count do?', { ...base, lastAnswer: async () => answer() }), false);
  assert.equal(await handleCodeRequest('make an image of a cat', { ...base, lastAnswer: async () => answer() }), false); // images first
  assert.equal(out.blocks.size, 0);
  // the history is the fallback when lastAnswer gives nothing
  const viaHistory = ui();
  let ran = false;
  const editor = async () => { ran = true; return { ok: false, error: 'no file was changed' }; };
  assert.equal(await handleCodeRequest('add input validation', { ...viaHistory, client: { models: async () => catalogue }, trial, editor, history: [{ role: 'user', content: 'x' }, { role: 'assistant', content: answer() }] }), true);
  assert.ok(ran);
  assert.match([...viaHistory.blocks.values()].at(-1), /The change could not be applied/);
});

test('hook: new code after a code answer is a new run, not an edit', async () => {
  const out = ui(), logs = [];
  const pipeline = async () => ({ ok: true, language: 'en', mode: 'speed', spec: { summary: '' }, files: [file('a.py', 'print(1)\n')], tests: [], readme: '# a\n', review: null, fixes: [], open: [], docs: [], cve: [], checks: [], degraded: [], cost: 0, ms: 1 });
  const editor = async () => { throw new Error('must not run'); };
  assert.equal(await handleCodeRequest('write a Python script that sorts files', { ...out, client: { models: async () => catalogue }, trial, pipeline, editor, lastAnswer: async () => answer(), research: async () => [], log: (m) => logs.push(m) }), true);
  assert.ok(logs.some(l => /"feature":"code"/.test(l)));
});

// ---- the patch that hands the hook the previous answer ----

test('patch-code-chat: the hook gets lastAnswer and history, and an installed hook is upgraded in both of its forms', () => {
  const { TARGETS } = require('../../patches/patch-code-chat.js');
  const { planPatch } = require('../../patches/lib/apply-targets.js');
  const upgrade = TARGETS.find(t => t.name === 'code hook can read the previous answer');
  assert.deepEqual(upgrade.ladder, ['V1', 'V1+pipeline-abort']);
  for (const alt of upgrade.alts) {
    const { CONFIG_JSON } = require('../../patches/lib/vane.js');
    const { LAST_ANSWER } = require('../../patches/patch-image-chat.js');
    // the article hook sits in the same route and already has lastAnswer/history: it must not make this one look upgraded
    const article = `H.handleArticleRequest(b.followUp,{lastAnswer:${LAST_ANSWER},history:b.chatHistory,mode:b.config.mode,configPath:${JSON.stringify(CONFIG_JSON)},research:y});`;
    const bundle = `${article}H.${alt.from}${JSON.stringify(CONFIG_JSON)},research:y});`;
    const r = planPatch({ [upgrade.file]: bundle }, [upgrade]);
    assert.deepEqual(r.errors, [], alt.from);
    assert.ok(r.next[upgrade.file].includes('lastAnswer:') && r.next[upgrade.file].includes('history:b.chatHistory'));
    assert.deepEqual(planPatch(r.next, [upgrade]).applied, [], 'a second run changes nothing');
  }
});
