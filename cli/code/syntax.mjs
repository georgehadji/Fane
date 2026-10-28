// Syntax check of generated files, without running them: `node --check` for JavaScript (it parses and stops),
// Python's ast.parse for Python (when a Python 3 is installed), JSON.parse for JSON. Other languages are reported
// as "unchecked", never as passing. The files are written to a fresh temporary folder and removed afterwards.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { languageOf } from './files.mjs';

const run = promisify(execFile);
const TIMEOUT_MS = 10_000;
// the first line of a parser's complaint, without the temporary folder's path
const firstLine = (s) => String(s || '').split('\n').map(l => l.trim()).find(l => /error/i.test(l)) || String(s || '').trim().split('\n')[0] || 'does not parse';
const clean = (s, dir) => firstLine(s).split(dir).join('').replace(/^[\\/]+/, '').slice(0, 200);

const PY_PARSE = 'import ast,sys\nwith open(sys.argv[1],encoding="utf-8") as f: ast.parse(f.read(),sys.argv[1])';

export function createSyntaxChecker({ node = process.execPath, pythons = ['python3', 'python', 'py'] } = {}) {
  let python; // the first Python 3 that answers, found once; null when there is none
  async function findPython() {
    if (python !== undefined) return python;
    python = null;
    for (const cmd of pythons) {
      try {
        const { stdout } = await run(cmd, [...(cmd === 'py' ? ['-3'] : []), '-c', 'import sys;print(sys.version_info[0])'], { timeout: 5000, windowsHide: true });
        if (stdout.trim() === '3') { python = cmd; break; }
      } catch { /* not installed (Windows' store alias exits with an error) */ }
    }
    return python;
  }

  // One file at a path inside `dir`. -> { status: 'ok' | 'error' | 'unchecked', detail }
  async function checkOne(file, dir) {
    const lang = languageOf(file.path);
    if (lang === 'json') {
      try { JSON.parse(file.content); return { status: 'ok' }; } catch (err) { return { status: 'error', detail: err.message.slice(0, 200) }; }
    }
    const ext = file.path.split('.').pop().toLowerCase();
    if (lang === 'javascript') {
      // a .js file may be either module kind; Node versions differ in detecting it, so one of the two must parse
      const kinds = ext === 'js' ? ['mjs', 'cjs'] : [ext];
      let error = '';
      for (const kind of kinds) {
        const p = join(dir, kind === ext ? file.path : file.path.replace(/\.js$/i, `.${kind}`));
        await writeFile(p, file.content);
        try { await run(node, ['--check', p], { timeout: TIMEOUT_MS, windowsHide: true }); return { status: 'ok' }; } catch (err) { error ||= clean(err.stderr || err.message, dir); }
      }
      return { status: 'error', detail: error };
    }
    if (lang === 'python') {
      const py = await findPython();
      if (!py) return { status: 'unchecked', detail: 'no Python 3 installed' };
      const p = join(dir, file.path);
      await writeFile(p, file.content);
      try { await run(py, [...(py === 'py' ? ['-3'] : []), '-c', PY_PARSE, p], { timeout: TIMEOUT_MS, windowsHide: true }); return { status: 'ok' }; } catch (err) { return { status: 'error', detail: clean(err.stderr || err.message, dir) }; }
    }
    return { status: 'unchecked' };
  }

  // files: [{ path (already safePath'd), content }] -> [{ path, status, detail? }]
  return async function checkSyntax(files) {
    const dir = await mkdtemp(join(tmpdir(), 'fane-code-'));
    try {
      const out = [];
      for (const f of files) {
        await mkdir(dirname(join(dir, f.path)), { recursive: true });
        out.push({ path: f.path, ...(await checkOne(f, dir)) });
      }
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
