// Coding pipeline (cli/code): intent, file handling, the pipeline with a fake client, the syntax check, the web
// answer, the hook and the trial's judges. No network, no Vane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { isCodeRequest } from '../core/intent-code.mjs';
import { MAX_FILE_CHARS, extractCode, fenceFor, fileChecks, languageOf, parseFiles, safePath } from '../code/files.mjs';
import { codePrompts } from '../code/prompts.mjs';
import { buildReadme, createCodePipeline, mapLimited, normalizeReview, normalizeSpec } from '../code/pipeline.mjs';
import { createSyntaxChecker } from '../code/syntax.mjs';
import { CODE_ANSWER_MARKER, codeTagged, renderCodeResult } from '../code/present.mjs';
import { handleCodeRequest } from '../code/vane-hook.mjs';
import { TRIAL_CASES, judgeTrialCode, judgeTrialSpec, selectCodeChains, buildCodeCatalogue } from '../code/catalogue.mjs';
import { ANSWER_MARKER } from '../image/present.mjs';
import { isArticleRequest, postPlatform } from '../core/intent-article.mjs';

const { autoRoute, parseCli } = await import('../vane.mjs');
const require = createRequire(import.meta.url);

test('code requests: a request verb and a code noun, or "in <language>"; text and ordinary nouns are not code', () => {
  for (const q of [
    'write a Python script that renames photos by date',
    'Write me a function to merge two sorted lists',
    'create a CLI tool for converting CSV to JSON',
    'implement quicksort in Rust',
    'can you write code that parses ISO dates?',
    'make a React component called Avatar',
    'build a REST API with FastAPI for a todo list',
    'write a report generator in Python',
    'give me a regex for email addresses',
    'write a Python class for a bank account',
    'γράψε ένα πρόγραμμα που μετράει λέξεις',
    'φτιάξε μια συνάρτηση σε Python που ταξινομεί λίστες',
    'γράψε κώδικα σε JavaScript για ένα χρονόμετρο',
  ]) assert.equal(isCodeRequest(q), true, q);
  for (const q of [
    'python script for renaming files',
    'write an article on machine learning in Python',
    'write a LinkedIn post about my Python library',
    'write an application letter for a job',
    'create a class for my students',
    'build a tool shed',
    'generate an image of a cat',
    'write a poem in Python style',
    'what is a Python decorator?',
    'γράψε ένα άρθρο για την Python',
    'γράψε μια ανάρτηση για το LinkedIn σχετικά με την JavaScript',
    // recommendations and plans, not code (all of these were code requests before)
    'show me the best apps for learning Greek',
    'give me tools for photo editing',
    'give me an app for tracking habits',
    'make a list of tools for gardening',
    'show me the code of conduct',
    'φτιάξε μου ένα πρόγραμμα γυμναστικής',
    'γράψε ένα πρόγραμμα διατροφής για την εβδομάδα',
    'φτιάξε μια λίστα με εργαλεία κήπου',
  ]) assert.equal(isCodeRequest(q), false, q);
  for (const q of [
    'show me a Python script that renames files',
    'give me a function to slugify text',
    'show me code that parses ISO dates',
    'build a tool for converting CSV to JSON',
    'φτιάξε ένα πρόγραμμα Python για αντίγραφα ασφαλείας',
    'φτιάξε μια εφαρμογή για λίστα αγορών',
  ]) assert.equal(isCodeRequest(q), true, q);
});

test('code requests are not articles or posts, and the CLI routes them to --code', () => {
  assert.equal(isArticleRequest('write a report generator in Python'), false);
  assert.equal(isArticleRequest('write a report on Python adoption'), true);
  assert.equal(postPlatform('write a LinkedIn post scheduler in Python'), null);
  assert.equal(postPlatform('write a LinkedIn post about Python'), 'linkedin');
  const route = (...argv) => autoRoute(parseCli(argv), argv);
  assert.equal(route('write a Python script that renames photos').code, true);
  assert.equal(route('write a Python script that renames photos', '--no-auto-code'), null);
  assert.equal(route('generate an image of a Python snake').image, true);
  assert.throws(() => parseCli(['--code', 'x', '--stream']), /does not apply to --code/);
});

test('safePath keeps relative paths inside the folder and refuses the rest', () => {
  assert.equal(safePath('src/app.py'), 'src/app.py');
  assert.equal(safePath('./a\\b.js'), 'a/b.js');
  assert.equal(safePath('.gitignore'), '.gitignore');
  for (const p of ['../x.js', 'a/../../x', '/etc/passwd', 'C:/Windows/x', '~/.ssh/k', '.git/hooks/pre-commit', 'nul.txt', 'a//b', 'a b.js', '', null]) assert.equal(safePath(p), null, String(p));
  // .git on a case-blind file system, and Windows dropping a trailing dot
  for (const p of ['.GIT/hooks/post-checkout', 'x/.Git/config', '.git./config', 'src./a.js']) assert.equal(safePath(p), null, p);
});

test('code out of answers: one fenced file, several "File:" blocks, and a fence the code cannot close', () => {
  assert.equal(extractCode('Here it is:\n```python\nprint(1)\n```\nUse it well.'), 'print(1)\n');
  assert.equal(extractCode('x = 1\ny = 2'), 'x = 1\ny = 2\n'); // no fence: the answer is the code
  assert.equal(extractCode('```js\nshort()\n```\n```js\nfunction longer() { return 1; }\n```'), 'function longer() { return 1; }\n');
  assert.equal(extractCode('````md\n```js\nx\n```\n````'), '```js\nx\n```\n'); // a longer fence holds a shorter one
  const files = parseFiles('File: tests/test_a.py\n```python\ndef test_a(): assert 1\n```\n\n### `test_b.js`\n```js\nok()\n```\n```js\nno path\n```\nFile: ../evil.py\n```python\nx\n```');
  assert.deepEqual(files.map(f => f.path), ['tests/test_a.py', 'test_b.js']);
  assert.deepEqual(parseFiles('File: Tests/a.py\n```py\nx\n```\nFile: tests/A.py\n```py\ny\n```').map(f => f.path), ['Tests/a.py']); // one file on Windows
  assert.equal(fenceFor('a ``` b'), '````');
  assert.equal(fenceFor('none'), '```');
  assert.equal(languageOf('src/main.py'), 'python');
  assert.equal(languageOf('Dockerfile'), 'dockerfile');
});

test('fileChecks: empty files and syntax errors fail; stubs and secrets warn', () => {
  const items = fileChecks([
    { path: 'a.py', content: 'def f():\n    # TODO: implement\n    pass\n' },
    { path: 'b.js', content: 'const key = "sk-abcdefghijklmnopqrstuvwxyz123";\n' },
    { path: 'c.js', content: '  \n' },
    { path: 'd.js', content: 'x(', syntax: { status: 'error', detail: 'Unexpected end of input' } },
    { path: 'e.py', content: 'try:\n    os.symlink(a, b)\nexcept (OSError, NotImplementedError):\n    pass\n' }, // catching it is not a stub
  ]);
  assert.deepEqual(items.map(i => `${i.path}:${i.level}:${i.name}`), ['a.py:warn:unfinished', 'b.js:warn:secret', 'c.js:fail:empty', 'd.js:fail:syntax']);
  // a todo app and an HTTP 501 are not stubs
  assert.deepEqual(fileChecks([
    { path: 'todo.py', content: 'def add(todo: Todo) -> None:\n    todos.append(todo)\n' },
    { path: 'srv.js', content: "res.writeHead(501); res.end('Not Implemented');\n" },
  ]), []);
});

test('normalizeSpec drops unsafe and repeated paths and a README, and caps the files', () => {
  const { spec, dropped } = normalizeSpec({ language: 'Python', framework: 'null', files: [{ path: 'a.py', purpose: 'main' }, { path: 'a.py' }, { path: '../x.py' }, { path: 'README.md' }, ...Array.from({ length: 14 }, (_, i) => ({ path: `m${i}.py` }))] });
  assert.equal(spec.framework, '');
  assert.equal(spec.files[0].path, 'a.py');
  assert.equal(spec.files.length, 12);
  assert.ok(dropped.some(d => /unusable path/.test(d)));
  assert.ok(dropped.some(d => /listed 15 files/.test(d)));
  assert.equal(normalizeSpec({ language: 'x', files: [{ path: '/abs' }] }).spec, null);
  assert.deepEqual(normalizeSpec({ language: 'JavaScript', files: [{ path: 'App.js' }, { path: 'app.js' }] }).spec.files.map(f => f.path), ['App.js']);
});

test('the fix prompt holds the whole file, up to MAX_FILE_CHARS', () => {
  const content = `${'x = 1\n'.repeat(9000)}last_line = True\n`; // 54k characters
  assert.ok(content.length > 40_000 && content.length <= MAX_FILE_CHARS);
  const { user } = codePrompts.fix({ text: 'r', spec: normalizeSpec({ language: 'Python', files: [{ path: 'big.py' }] }).spec, file: { path: 'big.py', content }, issues: [{ severity: 'high', issue: 'i' }] });
  assert.ok(user.includes('last_line = True'));
  assert.ok(!/cut at/.test(user));
});

test('normalizeReview pins findings to known files and says needs_fixes while any critical or high one is open', () => {
  const r = normalizeReview({ critical: [{ file: 'a.py', issue: 'SQL injection', fix: 'parameters' }], high: [{ file: 'nope.py', issue: 'x' }], medium: [{ file: 'a.py', issue: 'naming' }, { issue: '' }], verdict: 'approved' }, [{ path: 'a.py' }]);
  assert.equal(r.critical[0].file, 'a.py');
  assert.equal(r.high[0].file, null);
  assert.equal(r.high[0].named, 'nope.py');
  assert.equal(r.medium.length, 1);
  assert.equal(r.verdict, 'needs_fixes');
});

// ---- the pipeline with a fake client ----

const reply = (content, extra = {}) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0.001 }, ...extra });
const roleOf = (body) => {
  const s = body.messages[0].content;
  return /software architect/.test(s) ? 'spec' : /writing one file/.test(s) ? 'generate' : /security engineer/.test(s) ? 'review' : /integration pass/.test(s) ? 'fix' : /TDD specialist/.test(s) ? 'tests' : 'other';
};
const fileOf = (body) => /File to write: (\S+)/.exec(body.messages[1].content)?.[1] || /Fixes to apply to (\S+):/.exec(body.messages[1].content)?.[1];

function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    chat: async (body) => {
      const role = roleOf(body);
      calls.push({ role, file: fileOf(body), body });
      const a = answers[role];
      const out = typeof a === 'function' ? a(body) : a;
      if (out instanceof Error) throw out;
      return reply(out);
    },
  };
}

const SPEC = { language: 'JavaScript', framework: null, summary: 'A word counter.', files: [{ path: 'count.mjs', purpose: 'counts words', exports: ['countWords'] }, { path: 'cli.mjs', purpose: 'command line', imports: ['count.mjs'] }], dependencies: [], test_command: 'node --test', run: 'node cli.mjs file.txt' };
const GOOD = {
  'count.mjs': 'export function countWords(s) { return s.split(/\\s+/).filter(Boolean).length; }',
  'cli.mjs': "import { countWords } from './count.mjs';\nconsole.log(countWords(process.argv[2] ?? ''));",
};
const answers = (over = {}) => ({
  spec: JSON.stringify(SPEC),
  generate: (b) => `\`\`\`js\n${GOOD[fileOf(b)]}\n\`\`\``,
  review: JSON.stringify({ critical: [{ file: 'cli.mjs', issue: 'no input validation', fix: 'check argv' }], high: [], medium: [{ file: 'count.mjs', issue: 'regex per call' }], verdict: 'needs_fixes', security_posture: 'acceptable after the fix' }),
  fix: () => "```js\nimport { countWords } from './count.mjs';\nconst arg = process.argv[2];\nif (typeof arg !== 'string') { console.error('usage: cli <text>'); process.exit(2); }\nconsole.log(countWords(arg));\n```",
  tests: 'File: count.test.mjs\n```js\nimport test from "node:test";\nimport assert from "node:assert";\nimport { countWords } from "./count.mjs";\ntest("counts", () => assert.equal(countWords("a b"), 2));\n```',
  ...over,
});
const syntaxOk = async (files) => files.map(f => ({ path: f.path, status: 'ok' }));

test('pipeline (balanced): docs, spec, one call per file, review, a fix for the flagged file, tests and a README', async () => {
  const client = fakeClient(answers());
  const queries = [];
  const retrieve = async (q) => { queries.push(q); return [{ title: 'Node fs docs', url: 'https://nodejs.org/api/fs.html', content: 'readFile ...' }]; };
  const events = [];
  const r = await createCodePipeline({ client, retrieve, checkSyntax: syntaxOk })({ request: 'write a JavaScript CLI that counts words', mode: 'balanced', chains: { spec: ['m'], generate: ['m'], review: ['m'], fix: ['m'], tests: ['m'] }, onProgress: (e) => events.push(e) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(queries, ['write a JavaScript CLI that counts words']);
  assert.deepEqual(client.calls.map(c => c.role).sort(), ['fix', 'generate', 'generate', 'review', 'spec', 'tests']);
  assert.equal(client.calls.find(c => c.role === 'fix').file, 'cli.mjs'); // only the flagged file is fixed
  assert.match(r.files.find(f => f.path === 'cli.mjs').content, /usage: cli/);
  assert.equal(r.files.find(f => f.path === 'count.mjs').content, `${GOOD['count.mjs']}\n`);
  assert.deepEqual(r.tests.map(t => t.path), ['count.test.mjs']);
  assert.deepEqual(r.fixes.map(f => f.path), ['cli.mjs']);
  assert.deepEqual(r.open.map(i => i.issue), ['regex per call']); // medium findings stay open
  assert.match(r.readme, /^# write a JavaScript CLI that counts words/);
  assert.match(r.readme, /no input validation/);
  assert.match(r.readme, /node --test/);
  assert.ok(events.some(e => e.status === 'preview' && e.files));
  assert.equal(r.calls, 6);
  assert.ok(Math.abs(r.cost - 0.006) < 1e-9);
  // the review saw the whole files, and the generate calls the documentation as untrusted references
  assert.ok(client.calls.find(c => c.role === 'review').body.messages[1].content.includes(GOOD['cli.mjs']));
  assert.match(client.calls.find(c => c.role === 'generate').body.messages[1].content, /<references>[\s\S]*nodejs\.org/);
  assert.match(client.calls.find(c => c.role === 'generate').body.messages[0].content, /untrusted data/);
});

test('pipeline (speed): spec and files only, no research, no review', async () => {
  const client = fakeClient(answers());
  let searched = false;
  const r = await createCodePipeline({ client, retrieve: async () => { searched = true; return []; }, checkSyntax: syntaxOk })({ request: 'write a JS word counter', mode: 'speed' });
  assert.equal(r.ok, true);
  assert.equal(searched, false);
  assert.deepEqual(client.calls.map(c => c.role).sort(), ['generate', 'generate', 'spec']);
  assert.equal(r.review, null);
  assert.match(r.readme, /Not reviewed/);
});

test('pipeline: a fix that breaks the parse of a file that parsed is refused and the earlier file kept', async () => {
  const client = fakeClient(answers({ fix: () => '```js\nimport { countWords } from "./count.mjs"\nconsole.log(countWords(\n```' }));
  const checkSyntax = async (files) => files.map(f => ({ path: f.path, status: /countWords\($/m.test(f.content) ? 'error' : 'ok', detail: 'Unexpected end of input' }));
  const r = await createCodePipeline({ client, retrieve: async () => [], checkSyntax })({ request: 'write a JS word counter', mode: 'balanced' });
  assert.equal(r.ok, true);
  assert.equal(r.files.find(f => f.path === 'cli.mjs').content, `${GOOD['cli.mjs']}\n`);
  assert.equal(r.fixes.length, 0);
  assert.ok(r.open.some(i => i.issue === 'no input validation'));
  assert.ok(r.degraded.some(d => /fix of cli\.mjs was not used \(the fixed file does not parse/.test(d)));
  assert.equal(r.phases.find(p => p.phase === 'fix').status, 'rejected');
});

test('pipeline: a file that does not parse is sent to the fix step even without a finding', async () => {
  const client = fakeClient(answers({ generate: (b) => (fileOf(b) === 'count.mjs' ? '```js\nexport function countWords(s) {\n```' : `\`\`\`js\n${GOOD['cli.mjs']}\n\`\`\``), review: JSON.stringify({ verdict: 'approved' }), fix: () => `\`\`\`js\n${GOOD['count.mjs']}\n\`\`\`` }));
  const checkSyntax = async (files) => files.map(f => ({ path: f.path, status: f.content.includes('return') || f.path !== 'count.mjs' ? 'ok' : 'error', detail: 'Unexpected end of input' }));
  const r = await createCodePipeline({ client, retrieve: async () => [], checkSyntax })({ request: 'write a JS word counter', mode: 'balanced' });
  const fix = client.calls.find(c => c.role === 'fix');
  assert.equal(fix.file, 'count.mjs');
  assert.match(fix.body.messages[1].content, /does not parse: Unexpected end of input/);
  assert.equal(r.files.find(f => f.path === 'count.mjs').syntax.status, 'ok');
  assert.equal(r.checks.filter(c => c.level === 'fail').length, 0);
});

test('pipeline: a fix after which the file still does not parse is not reported as fixing the parse', async () => {
  const client = fakeClient(answers({ generate: (b) => (fileOf(b) === 'count.mjs' ? '```js\nexport function countWords(s) {\n```' : `\`\`\`js\n${GOOD['cli.mjs']}\n\`\`\``), review: JSON.stringify({ verdict: 'approved' }), fix: () => '```js\nexport function countWords(s) { s.split(\n```' }));
  const checkSyntax = async (files) => files.map(f => ({ path: f.path, status: f.path === 'count.mjs' ? 'error' : 'ok', detail: 'Unexpected end of input' }));
  const r = await createCodePipeline({ client, retrieve: async () => [], checkSyntax })({ request: 'write a JS word counter', mode: 'balanced' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fixes, []);
  assert.doesNotMatch(r.readme, /Fixed after the review/);
  assert.ok(r.degraded.some(d => /check "syntax" failed: count\.mjs/.test(d)));
});

test('pipeline: code that holds think tags is kept as written; only a leading reasoning block is removed', async () => {
  const code = "export const OPEN = '<think>';\nexport const strip = (s) => s.split('</think>').pop();";
  const client = fakeClient(answers({ generate: (b) => (fileOf(b) === 'count.mjs' ? `<think>plan the file</think>\n\`\`\`js\n${code}\n\`\`\`` : `\`\`\`js\n${GOOD['cli.mjs']}\n\`\`\``) }));
  const r = await createCodePipeline({ client, checkSyntax: syntaxOk })({ request: 'write a JS think-tag stripper', mode: 'speed', chains: { spec: ['m'], generate: ['m'] } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.files.find(f => f.path === 'count.mjs').content, `${code}\n`);
});

test('pipeline: after a 402 in one file the other workers start no new file', async () => {
  const { OpenRouterError } = await import('../image/openrouter.mjs');
  const spec = { language: 'JavaScript', files: Array.from({ length: 12 }, (_, i) => ({ path: `m${i}.mjs`, purpose: 'x' })) };
  const generated = [];
  const client = {
    chat: async (body) => {
      const role = roleOf(body);
      if (role === 'spec') return reply(JSON.stringify(spec));
      const file = fileOf(body);
      generated.push(file);
      if (file === 'm0.mjs') throw new OpenRouterError('402 no credits', 402);
      await new Promise(res => setTimeout(res, 20));
      return reply('```js\nexport const x = 1;\n```');
    },
  };
  const r = await createCodePipeline({ client, checkSyntax: syntaxOk })({ request: 'write a JS thing', mode: 'speed', chains: { spec: ['m'], generate: ['m'] } });
  assert.equal(r.fatal, true);
  await new Promise(res => setTimeout(res, 150)); // let workers that are still running finish
  assert.equal(generated.length, 4); // the four started together, no more
});

test('pipeline: a failed spec ends the run; a 402 stops it as fatal; one failed file is reported, not stored', async () => {
  const bad = await createCodePipeline({ client: fakeClient(answers({ spec: 'no json' })), checkSyntax: syntaxOk })({ request: 'write a JS word counter', mode: 'speed', chains: { spec: ['m'], generate: ['m'] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /specification failed/);
  const { OpenRouterError } = await import('../image/openrouter.mjs');
  const broke = await createCodePipeline({ client: fakeClient(answers({ spec: new OpenRouterError('402 no credits', 402) })), checkSyntax: syntaxOk })({ request: 'write a JS word counter', mode: 'speed' });
  assert.equal(broke.fatal, true);
  assert.equal(broke.status, 402);
  const one = await createCodePipeline({ client: fakeClient(answers({ generate: (b) => (fileOf(b) === 'cli.mjs' ? '' : `\`\`\`js\n${GOOD['count.mjs']}\n\`\`\``) })), checkSyntax: syntaxOk })({ request: 'write a JS word counter', mode: 'speed', chains: { spec: ['m'], generate: ['m'] } });
  assert.equal(one.ok, true);
  assert.deepEqual(one.files.map(f => f.path), ['count.mjs']);
  assert.ok(one.degraded.some(d => /^cli\.mjs could not be written/.test(d)));
});

test('README is written by code and quotes the request', () => {
  const { spec } = normalizeSpec(SPEC);
  const readme = buildReadme({ request: 'γράψε ένα πρόγραμμα', spec, files: [{ path: 'count.mjs' }], tests: [], review: null, fixes: [], open: [], mode: 'speed', lang: 'el' });
  assert.match(readme, /## Αρχεία/);
  assert.match(readme, /> γράψε ένα πρόγραμμα/);
});

test('syntax check: JavaScript with node --check, JSON in process, Python with ast.parse when installed, the rest unchecked', async () => {
  const check = createSyntaxChecker();
  const r = await check([
    { path: 'ok.mjs', content: 'export const a = 1;\n' },
    { path: 'bad.mjs', content: 'export const = ;\n' },
    { path: 'esm.js', content: "import fs from 'node:fs';\nexport default fs;\n" },
    { path: 'cjs.js', content: "const fs = require('fs');\nmodule.exports = fs;\n" },
    { path: 'sub/data.json', content: '{"a": 1}' },
    { path: 'broken.json', content: '{a:1}' },
    { path: 'x.rs', content: 'fn main() {}' },
    { path: 'never.mjs', content: "require('node:fs').writeFileSync('fane-must-not-exist.txt', 'ran');\n" },
  ]);
  const by = Object.fromEntries(r.map(x => [x.path, x]));
  assert.equal(by['ok.mjs'].status, 'ok');
  assert.equal(by['bad.mjs'].status, 'error');
  assert.ok(by['bad.mjs'].detail && !by['bad.mjs'].detail.includes('fane-code-'), by['bad.mjs'].detail); // no temporary path in the message
  assert.equal(by['esm.js'].status, 'ok');
  assert.equal(by['cjs.js'].status, 'ok');
  assert.equal(by['sub/data.json'].status, 'ok');
  assert.equal(by['broken.json'].status, 'error');
  assert.equal(by['x.rs'].status, 'unchecked');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync('fane-must-not-exist.txt'), false); // parsed, never run
  let python = null;
  for (const cmd of ['python3', 'python']) { try { if (execFileSync(cmd, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true }).trim() === '3') { python = cmd; break; } } catch { /* not here */ } }
  const py = await check([{ path: 'ok.py', content: 'def f(x: int) -> int:\n    return x\n' }, { path: 'bad.py', content: 'def f(:\n' }]);
  if (python) assert.deepEqual(py.map(x => x.status), ['ok', 'error']);
  else assert.deepEqual(py.map(x => x.status), ['unchecked', 'unchecked']);
});

test('syntax check: an ast.py in the current folder (a file of an earlier run) is not imported by the Python check', async (t) => {
  let python = null;
  for (const cmd of ['python3', 'python']) { try { if (execFileSync(cmd, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true }).trim() === '3') { python = cmd; break; } } catch { /* not here */ } }
  if (!python) return t.skip('no Python 3');
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fane-cwd-'));
  writeFileSync(join(dir, 'ast.py'), "open('ran.txt', 'w').write('ran')\n");
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const [r] = await createSyntaxChecker({ pythons: [python] })([{ path: 'ok.py', content: 'x = 1\n' }]);
    assert.equal(r.status, 'ok');
    assert.equal(existsSync(join(dir, 'ran.txt')), false);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the web answer and the hook ----

test('the web answer: files in fences longer than their backticks, escaped paths and summary, both markers', async () => {
  const r = {
    language: 'en', mode: 'balanced', spec: { summary: 'Uses <b>bold</b> ideas.' }, cost: 0.0123, ms: 65_000,
    files: [{ path: '__init__.py', content: 'x = "```"\n', syntax: { status: 'ok' } }],
    tests: [{ path: 'test_x.py', content: 'def test(): pass\n', syntax: { status: 'error', detail: 'bad' } }],
    readme: '# T\n\n```\nrun\n```\n', review: { posture: 'ok', verdict: 'needs_fixes' }, fixes: [{ path: '__init__.py', issues: [{ file: '__init__.py', severity: 'high', issue: 'a <script> issue' }] }], open: [],
    docs: [{ title: 'Docs', url: 'https://docs.python.org/3/' }], cve: [], checks: [], degraded: ['the review saw 1 file'],
  };
  const html = renderCodeResult(r);
  assert.match(html, /<h4>__init__\.py<\/h4>\n\n````python\nx = "```"\n````/);
  assert.match(html, /Uses &lt;b&gt;bold&lt;\/b&gt; ideas\./);
  assert.match(html, /a &lt;script&gt; issue/);
  assert.match(html, /<a href="https:\/\/docs\.python\.org\/3\/">Docs<\/a>/);
  assert.match(html, /syntax: 1 parses, 1 does not parse/);
  const tagged = codeTagged(html);
  assert.ok(tagged.includes(CODE_ANSWER_MARKER) && tagged.endsWith(ANSWER_MARKER));
  const { CODE_ANSWER_MARKER: inPatches } = require('../../patches/lib/vane.js');
  assert.equal(CODE_ANSWER_MARKER, inPatches);
  const { TARGETS } = require('../../patches/patch-code-chat.js');
  assert.ok(TARGETS[1].to.startsWith(`s=s.includes(${JSON.stringify(CODE_ANSWER_MARKER)})?s:l.length>0?`));
});

test('hook: not a coding request -> false; no trial -> a message; a run -> files in the answer, research closed', async () => {
  const ui = () => { const blocks = new Map(); let n = 0; return { blocks, emit: (x) => { const id = `b${++n}`; blocks.set(id, x); return id; }, update: (id, x) => blocks.set(id, x) }; };
  const plain = ui();
  assert.equal(await handleCodeRequest('what is a closure?', { ...plain, client: {} }), false);
  assert.equal(plain.blocks.size, 0);

  const none = ui();
  const catalogue = [{ id: 'lab/coder', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, supported_parameters: ['response_format'] }];
  assert.equal(await handleCodeRequest('write a Python script that sorts files', { ...none, client: { models: async () => catalogue }, trial: {} }), true);
  assert.match([...none.blocks.values()][0], /coding trial/);

  const run = ui();
  let closed = 0;
  const pipeline = async ({ onProgress }) => {
    onProgress({ phase: 'docs', status: 'done' });
    return { ok: true, language: 'en', mode: 'balanced', spec: { summary: '' }, files: [{ path: 'a.py', content: 'print(1)\n', syntax: { status: 'ok' } }], tests: [], readme: '# a\n', review: null, fixes: [], open: [], docs: [], cve: [], checks: [], degraded: [], cost: 0, ms: 1000 };
  };
  const trial = { 'lab/coder': { code: { ok: true, score: 0 }, json: { ok: true } } };
  assert.equal(await handleCodeRequest('write a Python script that sorts files', { ...run, client: { models: async () => catalogue }, trial, pipeline, research: async () => [], researchDone: () => closed++, mode: 'balanced' }), true);
  const final = [...run.blocks.values()][0];
  assert.match(final, /<h4>a\.py<\/h4>\n\n```python\nprint\(1\)\n```/);
  assert.ok(final.includes(CODE_ANSWER_MARKER));
  assert.equal(closed, 1);
});

// ---- the trial ----

test('trial judges: the code must pass all cases but one; the spec must be JSON with a usable path', () => {
  const all = TRIAL_CASES.map(() => ({ ok: true }));
  assert.equal(judgeTrialCode('```js\nexport function parseDuration() {}\n```', { results: all }).ok, true);
  assert.equal(judgeTrialCode('```js\nx\n```', { results: all.map((x, i) => ({ ok: i > 0 })) }).ok, true);
  const two = judgeTrialCode('```js\nx\n```', { results: all.map((x, i) => ({ ok: i > 1 })) });
  assert.equal(two.ok, false);
  assert.match(two.problems[0], /passed 16 of 18/);
  assert.match(judgeTrialCode('```js\nx\n```', { loadError: 'SyntaxError: x' }).problems[0], /does not load/);
  assert.equal(judgeTrialCode('```js\nx\n```', { results: all, finish: 'length' }).ok, false);
  assert.equal(judgeTrialSpec('{"language": "Python", "files": [{"path": "wc.py"}]}').ok, true);
  assert.equal(judgeTrialSpec('{"language": "Python", "files": [{"path": "../wc.py"}]}').ok, false);
  assert.equal(judgeTrialSpec('nope').ok, false);
});

test('code chains come from the code trial and include code specialists the article catalogue leaves out', () => {
  const entry = (id, price) => ({ id, architecture: { output_modalities: ['text'] }, pricing: { prompt: String(price / 1e6), completion: String(price * 2 / 1e6) }, context_length: 128000, supported_parameters: ['response_format'] });
  const catalogue = buildCodeCatalogue([entry('a/coder-1', 1), entry('b/model-2', 2), entry('c/model-3', 3)]);
  assert.ok(catalogue.some(m => m.id === 'a/coder-1'));
  const trial = { 'a/coder-1': { code: { ok: true, score: 0 }, json: { ok: true } }, 'b/model-2': { code: { ok: true, score: 1 }, json: { ok: false } }, 'c/model-3': { code: { ok: false } } };
  const chosen = selectCodeChains(catalogue, trial, { mode: 'balanced' });
  assert.deepEqual(Object.keys(chosen.chains).sort(), ['fix', 'generate', 'review', 'spec', 'tests']);
  assert.equal(chosen.pool, 2);
  assert.ok(!chosen.chains.spec.includes('b/model-2')); // spec and review need a JSON pass
  assert.ok(!Object.values(chosen.chains).flat().includes('c/model-3'));
});

test('mapLimited: a throw waits for the items already running, and starts no new one', async () => {
  const done = [];
  await assert.rejects(mapLimited([0, 1, 2, 3], 2, async (i) => {
    if (i === 0) throw new Error('402 stop');
    await new Promise(r => setTimeout(r, 30));
    done.push(i);
  }), /402 stop/);
  assert.deepEqual(done, [1]);
});

test('the code trial runs model code with an empty environment', async () => {
  const { runCases } = await import('../../scripts/code-sandbox.mjs');
  process.env.FANE_SANDBOX_PROBE = 'secret';
  try {
    const code = "if (process.env.FANE_SANDBOX_PROBE) throw new Error('env leaked');\nexport const parseDuration = (s) => Number(s);";
    assert.deepEqual(await runCases(code, [['5', 5]]), { results: [{ ok: true }] });
  } finally { delete process.env.FANE_SANDBOX_PROBE; }
});
