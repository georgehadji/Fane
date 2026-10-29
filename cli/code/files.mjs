// The files a coding run produces. Pure functions:
//  - safePath: a path a model proposes is checked before anything is written or shown (no absolute path, drive
//    letter, "..", .git, or Windows device name), because `vane --code` writes the files to disk;
//  - extractCode / parseFiles: the code out of a model's fenced answer (one file, or "File: path" + fence each);
//  - fenceFor: a fence the code cannot close, for Markdown answers;
//  - fileChecks: deterministic checks of the contract the prompts state (no stubs, no secrets, not empty).

// Most files of a real project fit; a model that writes more than this has usually looped.
export const MAX_FILE_CHARS = 60_000;

const DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

export function safePath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!s || s.length > 200 || s.startsWith('/') || s.startsWith('~') || /^[a-z]:/i.test(s)) return null;
  const parts = s.split('/');
  // Windows and macOS match names case-blind and Windows drops a trailing dot: ".GIT" and ".git." are .git there
  if (parts.some(x => !x || x.endsWith('.') || x.toLowerCase() === '.git' || DEVICE.test(x) || !/^[\w.@+-]+$/.test(x))) return null;
  return parts.join('/');
}

const LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', tsx: 'tsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', ps1: 'powershell', sql: 'sql',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown', html: 'html', css: 'css', scss: 'scss',
  vue: 'vue', svelte: 'svelte', dart: 'dart', lua: 'lua', r: 'r', ex: 'elixir', exs: 'elixir', scala: 'scala',
};
export const languageOf = (path) => {
  const name = String(path).split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  return LANGS[name.includes('.') ? name.split('.').pop() : ''] || '';
};

// One file on a case-blind file system (Windows, macOS): "App.js" and "app.js" cannot both be written.
export const sameFile = (a, b) => a.toLowerCase() === b.toLowerCase();

// Fenced blocks: an opening fence of 3+ backticks or tildes (with an info string), closed by a bare fence of the same
// character and at least the same length. Inside an open block, a fence line of the same length WITH an info string
// opens a nested block that the next bare fence closes, so a README or a Python docstring that shows a ```bash
// example inside its own fence is one block, not cut at the example's closing fence. An unclosed block is no block.
// shortcut: an unlabelled inner fence ("```" alone) still closes the block; models that nest them use a longer outer fence.
export function codeBlocks(text) {
  const s = String(text || '');
  const out = [];
  let open = null, pos = 0;
  for (const raw of s.split('\n')) {
    const start = pos;
    pos += raw.length + 1;
    const line = raw.trimEnd();
    const m = /^([`~]{3,})(.*)$/.exec(line);
    // a backtick fence's info string has no backtick: "```x```" is code inside a sentence
    const fence = m && !(m[1][0] === '`' && m[2].includes('`')) ? m : null;
    if (!open) {
      if (fence) open = { fence: fence[1], info: fence[2].trim(), start, body: pos, depth: 1 };
      continue;
    }
    if (!fence || fence[1][0] !== open.fence[0]) continue;
    if (fence[2].trim()) { if (fence[1].length === open.fence.length) open.depth++; continue; }
    if (fence[1].length < open.fence.length || --open.depth) continue;
    out.push({ info: open.info, code: s.slice(open.body, Math.max(open.body, start - 1)), start: open.start, end: start + line.length });
    open = null;
  }
  return out;
}

// One file from an answer that should be a single fenced block. Without a fence the answer is taken as the code
// (some models leave the fence out); with several, the longest is the file and the rest are examples.
export function extractCode(text) {
  const blocks = codeBlocks(text);
  const code = blocks.length ? blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code : String(text || '');
  const trimmed = code.replace(/^\n+/, '').replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n` : '';
}

// Several files: each fence is preceded by a line naming its path ("File: tests/test_x.py", "### `x.js`").
// A block whose path is missing or unsafe is dropped. -> [{ path, content }]
// the line's last word, whole ("../x.py" stays "../x.py" so safePath refuses it), without Markdown around it
const pathInLine = (line) => {
  const word = line.split(/\s+/).pop().replace(/^[`*#]+|[`*:]+$/g, '');
  return /\.[A-Za-z0-9]+$|^(?:Dockerfile|Makefile)$/.test(word) ? word : null;
};
export function parseFiles(text) {
  const s = String(text || '');
  const files = [];
  let from = 0;
  for (const b of codeBlocks(s)) {
    const before = s.slice(from, b.start).split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
    from = b.end;
    const path = safePath(pathInLine(before) || b.info.match(/(?:title|file(?:name)?)=["']?([^"'\s]+)/)?.[1]);
    const content = b.code.replace(/\s+$/, '');
    if (path && content && !files.some(f => sameFile(f.path, path))) files.push({ path, content: `${content}\n` });
  }
  return files;
}

// A Markdown fence one backtick longer than any run of backticks inside the code.
export const fenceFor = (code) => '`'.repeat(Math.max(3, ...[...String(code).matchAll(/`+/g)].map(m => m[0].length + 1)));

// The markers in capitals only: `todo` is an ordinary name in a todo app, and "Not Implemented" is HTTP 501.
const STUB_MARK = /\b(?:TODO|FIXME|XXX)\b/;
const STUB = /your (?:code|implementation|logic) here|implement (?:this|me|the rest)|rest of (?:the )?(?:code|implementation|file)|\.\.\.\s*(?:existing|rest|more|remaining)\b|not yet implemented|raise NotImplementedError/i; // catching NotImplementedError is fine (a live test did)
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|api_?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i;

// -> [{ path, level: 'fail' | 'warn', name, detail }]
export function fileChecks(files) {
  const items = [];
  for (const f of files) {
    if (!f.content.trim()) items.push({ path: f.path, level: 'fail', name: 'empty', detail: `${f.path} is empty` });
    const stub = STUB_MARK.exec(f.content) || STUB.exec(f.content);
    if (stub) items.push({ path: f.path, level: 'warn', name: 'unfinished', detail: `${f.path}: "${stub[0]}"` });
    if (SECRET.test(f.content)) items.push({ path: f.path, level: 'warn', name: 'secret', detail: `${f.path} seems to contain a hard-coded secret` });
    if (f.syntax?.status === 'error') items.push({ path: f.path, level: 'fail', name: 'syntax', detail: `${f.path}: ${f.syntax.detail}` });
  }
  return items;
}
