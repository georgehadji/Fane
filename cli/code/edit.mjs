// Follow-up edits of code the web chat wrote ("add input validation", "rename parse to parse_line"): the earlier answer
// is read back into files, and a change is matched to the files it names. Pure functions; createCodeEditor
// (pipeline.mjs) makes the model calls. Lives beside present.mjs because it reads what renderCodeResult wrote.
import { MAX_FILE_CHARS, codeBlocks, languageOf, safePath, sameFile } from './files.mjs';
import { MAX_FILES } from './models.mjs';
import { CODE_ANSWER_MARKER } from './present.mjs';

const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const TESTS_HEAD = /<h3>(?:Tests|Έλεγχοι)<\/h3>/;
const README = /^readme(?:\.md)?$/i;

// The text of an earlier answer -> { files, tests, summary, language } | null. The answer is what renderCodeResult
// wrote: a summary paragraph, each file as an <h4> path and a fence, a "Tests" heading and the test files, the
// README, the review, then the status paragraph and the markers. Null without CODE_ANSWER_MARKER or without a file.
// The fences are found first and the headings only in the text between them, so a file that itself holds "<h4>"
// (an HTML page) cannot be taken for a heading. Every path goes through safePath: an unsafe one is dropped.
export function parseCodeAnswer(answer) {
  const text = String(answer || '');
  if (!text.includes(CODE_ANSWER_MARKER)) return null;
  const files = [], tests = [];
  let summary = '', prev = 0, inTests = false, first = true;
  for (const b of codeBlocks(text)) {
    const before = text.slice(prev, b.start);
    prev = b.end;
    if (first) { summary = unescapeHtml(/^\s*<p>([\s\S]*?)<\/p>/.exec(before)?.[1] ?? '').replace(/<br>/g, ' ').trim(); first = false; }
    if (TESTS_HEAD.test(before)) inTests = true;
    const named = /<h4>([^<]*)<\/h4>\s*$/.exec(before);
    const path = named && safePath(unescapeHtml(named[1]));
    if (!path || README.test(path)) continue;
    const content = b.code.replace(/\s+$/, '');
    if (!content) continue;
    if ([...files, ...tests].some(f => sameFile(f.path, path))) continue;
    (inTests ? tests : files).push({ path, content: `${content}\n`, role: inTests ? 'test' : 'source' });
  }
  if (!files.length) return null;
  return { files, tests, summary, language: languageOf(files[0].path) };
}

// Which files a change goes to: the ones it names by path or by file name ("in utils/io.py", "the parse.js file"), plus
// the tests when it talks about tests; when it names none, every source file (each call may answer UNCHANGED).
// A file over MAX_FILE_CHARS is left out. -> { targets, skipped } (skipped: files left out for size or for MAX_FILES)
export function pickTargets(change, files, tests = []) {
  const text = String(change || '').toLowerCase();
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = (s) => new RegExp(String.raw`(?<![\w./-])${escape(s)}(?![\w-])`).test(text); // "a.py" is not in "test_a.py"
  const names = (f) => { const p = f.path.toLowerCase(); return at(p) || at(p.split('/').pop()); };
  const talksTests = /\btests?\b|\btesting\b|έλεγχ|τεστ/.test(text);
  const pool = [...files, ...(talksTests ? tests : [])];
  const named = [...files, ...tests].filter(names); // a test file named by its path counts even without the word "test"
  const wanted = named.length ? named : pool;
  const fits = wanted.filter(f => f.content.length <= MAX_FILE_CHARS);
  const targets = fits.slice(0, MAX_FILES);
  return { targets, skipped: wanted.filter(f => !targets.includes(f)).map(f => f.path) };
}
