#!/usr/bin/env node
// Applies the Fane patches and SearXNG settings to the local Vane container,
// restarts it only if something changed, then runs `vane --doctor`.
// Safe to re-run. Uses execFile (no shell), so it works the same from
// PowerShell, cmd and Git Bash (no /tmp path rewriting).
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DEFAULTS } from '../cli/vane.mjs';

const { FANE_IMAGE_DIR, FANE_WRITE_DIR } = createRequire(import.meta.url)('../patches/lib/vane.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = DEFAULTS.container;
const SETTINGS_PATH = '/etc/searxng/settings.yml';
const PATCH_DIR = '/tmp/fane-patches'; // the whole folder: patches share patches/lib/
// The key line itself, not its placeholder value, so the repo file is the only place that
// says what the placeholder is.
const SECRET_KEY_LINE = /^(\s*secret_key:).*$/m;

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`Usage: node scripts/apply.mjs [--no-searxng]\nEnv: VANE_CONTAINER (default ${DEFAULTS.container}), VANE_URL (default ${DEFAULTS.url})`);
  process.exit(0);
}
const withSearxng = !process.argv.includes('--no-searxng');

function docker(args, timeout = 60_000) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
}

function fail(msg) {
  console.error(`apply: ${msg}`);
  process.exit(1);
}

try {
  if (docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]) !== 'true') fail(`container "${CONTAINER}" is stopped. Run: docker start ${CONTAINER}`);
} catch (err) {
  fail(`cannot inspect container "${CONTAINER}": ${(err.stderr || err.message).toString().split('\n')[0]}. Is Docker running and Vane installed (README, Requirements)?`);
}

let changed = false;
let failed = false;

// 1. Patches: each script exits non-zero without touching files when its target does not match.
docker(['exec', '-u', '0', CONTAINER, 'rm', '-rf', PATCH_DIR]);
docker(['cp', join(ROOT, 'patches'), `${CONTAINER}:${PATCH_DIR}`]);
for (const file of readdirSync(join(ROOT, 'patches')).filter(f => /^patch-.*\.js$/.test(f)).sort()) {
  try {
    const out = docker(['exec', '-u', '0', CONTAINER, 'node', `${PATCH_DIR}/${file}`]);
    console.log(out.split('\n').join(' | ')); // each line already starts with the patch name
    if (out.split('\n').some(l => /patched/.test(l) && !/already patched/.test(l))) changed = true;
  } catch (err) {
    failed = true;
    console.error(`${file}: FAILED. ${(err.stderr || err.message).toString().trim().split('\n')[0]}`);
  }
}

// 1b. Fane's image and article modules, used by patch-image-chat and patch-article-chat from inside
// Vane (the article folder also holds trial.json). Node caches imported modules, so a changed copy
// needs the restart below.
for (const [name, dest] of [['image', FANE_IMAGE_DIR], ['write', FANE_WRITE_DIR]]) {
  const keep = (f) => f.endsWith('.mjs') || f.endsWith('.json');
  const local = Object.fromEntries(readdirSync(join(ROOT, 'cli', name)).filter(keep).sort()
    .map(f => [f, createHash('sha256').update(readFileSync(join(ROOT, 'cli', name, f))).digest('hex')]));
  let remote = {};
  try {
    remote = JSON.parse(docker(['exec', CONTAINER, 'node', '-e', `const fs=require('fs'),c=require('crypto'),d=${JSON.stringify(dest)};const o={};try{for(const f of fs.readdirSync(d).filter(f=>f.endsWith('.mjs')||f.endsWith('.json')).sort())o[f]=c.createHash('sha256').update(fs.readFileSync(d+'/'+f)).digest('hex')}catch{}console.log(JSON.stringify(o))`]));
  } catch { /* treat as missing */ }
  if (JSON.stringify(local) === JSON.stringify(remote)) console.log(`cli/${name}: already in ${dest}`);
  else {
    docker(['exec', '-u', '0', CONTAINER, 'sh', '-c', `rm -rf ${dest} && mkdir -p ${dirname(dest)}`]);
    docker(['cp', join(ROOT, 'cli', name), `${CONTAINER}:${dest}`]);
    console.log(`cli/${name}: copied to ${dest}`);
    changed = true;
  }
}

// 2. SearXNG settings. The secret_key is generated per install and never written to the repo.
if (withSearxng) {
  const repoText = readFileSync(join(ROOT, 'searxng', 'settings.yml'), 'utf8');
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(SECRET_KEY_LINE, '$1 X').trim();
  let current = '';
  try { current = docker(['exec', CONTAINER, 'cat', SETTINGS_PATH]); } catch { /* treat as different */ }
  if (norm(current) === norm(repoText)) {
    console.log('searxng/settings.yml: already applied');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'fane-'));
    try {
      const tmp = join(dir, 'settings.yml');
      writeFileSync(tmp, repoText.replace(SECRET_KEY_LINE, `$1 '${randomBytes(32).toString('hex')}'`));
      docker(['cp', tmp, `${CONTAINER}:${SETTINGS_PATH}`]);
      docker(['exec', '-u', '0', CONTAINER, 'chown', 'searxng:searxng', SETTINGS_PATH]);
      console.log('searxng/settings.yml: applied with a new random secret_key');
      changed = true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// 3. Restart only if something changed, then wait for the API.
if (changed) {
  docker(['restart', CONTAINER]);
  process.stdout.write('restarting');
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write('.');
    ready = await fetch(`${DEFAULTS.url}/api/providers`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok, () => false);
  }
  console.log(ready ? ' ready' : ' not ready after 90s');
} else {
  console.log('nothing changed; not restarting');
}

// 4. Verify.
const doctor = spawnSync(process.execPath, [join(ROOT, 'cli', 'vane.mjs'), '--doctor'], { stdio: 'inherit' });
process.exit(failed || doctor.status ? 1 : 0);
