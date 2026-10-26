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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = process.env.VANE_CONTAINER || 'vane';
const URL_ = process.env.VANE_URL || 'http://localhost:3000';
const PLACEHOLDER = 'REPLACE_ME_RUN_THE_COMMAND_IN_README';
const SETTINGS_PATH = '/etc/searxng/settings.yml';

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log('Usage: node scripts/apply.mjs [--no-searxng]\nEnv: VANE_CONTAINER (default vane), VANE_URL (default http://localhost:3000)');
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
for (const file of readdirSync(join(ROOT, 'patches')).filter(f => f.endsWith('.js')).sort()) {
  const dest = `/tmp/${file}`;
  docker(['cp', join(ROOT, 'patches', file), `${CONTAINER}:${dest}`]);
  try {
    const out = docker(['exec', '-u', '0', CONTAINER, 'node', dest]);
    console.log(`${file}: ${out.split('\n').join(' | ')}`);
    if (out.split('\n').some(l => /patched/.test(l) && !/already patched/.test(l))) changed = true;
  } catch (err) {
    failed = true;
    console.error(`${file}: FAILED. ${(err.stderr || err.message).toString().trim().split('\n')[0]}`);
  }
}

// 2. SearXNG settings. The secret_key is generated per install and never written to the repo.
if (withSearxng) {
  const repoText = readFileSync(join(ROOT, 'searxng', 'settings.yml'), 'utf8');
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/^(\s*secret_key:).*$/m, '$1 X').trim();
  let current = '';
  try { current = docker(['exec', CONTAINER, 'cat', SETTINGS_PATH]); } catch { /* treat as different */ }
  if (norm(current) === norm(repoText)) {
    console.log('searxng/settings.yml: already applied');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'fane-'));
    try {
      const tmp = join(dir, 'settings.yml');
      writeFileSync(tmp, repoText.replace(PLACEHOLDER, randomBytes(32).toString('hex')));
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
    ready = await fetch(`${URL_}/api/providers`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok, () => false);
  }
  console.log(ready ? ' ready' : ' not ready after 90s');
} else {
  console.log('nothing changed; not restarting');
}

// 4. Verify.
const doctor = spawnSync(process.execPath, [join(ROOT, 'cli', 'vane.mjs'), '--doctor'], { stdio: 'inherit' });
process.exit(failed || doctor.status ? 1 : 0);
