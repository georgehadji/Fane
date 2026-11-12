#!/usr/bin/env node
// Applies the Fane patches and SearXNG settings to the local Vane container,
// restarts it only if something changed, then runs `vane --doctor`.
// Safe to re-run. Uses execFile (no shell), so it works the same from
// PowerShell, cmd and Git Bash (no /tmp path rewriting).
// `applyFane` takes everything that touches the outside (docker, the environment, output, the readiness wait and the
// doctor) as parameters, defaulting to the real thing, so cli/test/apply.test.mjs can drive it with a fake docker.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DEFAULTS } from '../cli/vane.mjs';
import { KEYED_ENGINES, SECRET_KEY_LINE, renderSettings } from './searxng-settings.mjs';

const require = createRequire(import.meta.url);
const { FANE_CORE_DIR, FANE_IMAGE_DIR, FANE_WRITE_DIR, FANE_CODE_DIR, FANE_BRAINSTORM_DIR, needsRestart } = require('../patches/lib/vane.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_PATH = '/etc/searxng/settings.yml';
const PATCH_DIR = '/tmp/fane-patches'; // the whole folder: patches share patches/lib/

const HELP = `Usage: node scripts/apply.mjs [--no-searxng]\nEnv: VANE_CONTAINER (default ${DEFAULTS.container}), VANE_URL (default ${DEFAULTS.url}),\n     CORE_API_KEY (switches on the CORE academic engine; never printed),\n     BRAVE_API_KEY (switches on the Brave Search API engine; never printed),\n     TAVILY_API_KEY (switches on the Tavily engine; never printed),\n     PERPLEXITY_API_KEY (switches on the Perplexity Search API engine; never printed)`;

const realDocker = (args, timeout = 60_000) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();

// The files a patch run says it wrote: one `<name>: changed <file>` line each (patches/lib/apply-targets.js run()).
export function changedFiles(out) {
  return out.split('\n').map(l => /^[^\s:]+: changed (\/.+)$/.exec(l.trim())?.[1]).filter(Boolean);
}

// True when the container runs Fane's entrypoint with the repo mounted under /fane: docker-compose.yml made it, and
// that entrypoint re-applies the patches and settings at every start. Inputs are `docker inspect` JSON texts.
export function managedByCompose(entrypointJson, mountsJson) {
  try {
    const entrypoint = JSON.parse(entrypointJson) || [];
    const mounts = JSON.parse(mountsJson) || [];
    return entrypoint.some(e => /fane-entrypoint\.sh$/.test(e)) && mounts.some(m => String(m.Destination).startsWith('/fane/'));
  } catch { return false; }
}

async function waitForVane(url, write) {
  write('restarting');
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    await new Promise(r => setTimeout(r, 2000));
    write('.');
    ready = await fetch(`${url}/api/providers`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok, () => false);
  }
  return ready;
}

const runDoctor = () => spawnSync(process.execPath, [join(ROOT, 'cli', 'vane.mjs'), '--doctor'], { stdio: 'inherit' }).status;

// Returns the exit code: 0 ok, 1 a refusal or a failed step (or a failing doctor).
export async function applyFane({
  docker = realDocker,
  env = process.env,
  argv = [],
  container = DEFAULTS.container,
  url = DEFAULTS.url,
  log = console.log,
  error = console.error,
  write = (s) => process.stdout.write(s),
  waitReady = waitForVane,
  doctor = runDoctor,
  root = ROOT,
} = {}) {
  if (argv.includes('-h') || argv.includes('--help')) { log(HELP); return 0; }
  const withSearxng = !argv.includes('--no-searxng');
  const fail = (msg) => { error(`apply: ${msg}`); return 1; };

  let info;
  try {
    info = docker(['inspect', '-f', '{{.State.Running}}@@{{json .Config.Entrypoint}}@@{{json .Mounts}}', container]).split('@@');
  } catch (err) {
    return fail(`cannot inspect container "${container}": ${(err.stderr || err.message).toString().split('\n')[0]}. Is Docker running and Vane installed (README, Requirements)?`);
  }
  // Compose first, even when stopped: its entrypoint re-applies everything at the start, and this script would be a second
  // writer of the same files.
  if (managedByCompose(info[1], info[2])) return fail(`container "${container}" is managed by Compose (it runs fane-entrypoint.sh with /fane mounted): run \`docker compose restart vane\`. The entrypoint re-applies the patches and settings at every start; this script would only write them a second time.`);
  if (info[0] !== 'true') return fail(`container "${container}" is stopped. Run: docker start ${container}`);

  let changed = false; // something Vane's server reads changed: restart
  const browserOnly = []; // patches that changed only browser files: a page reload is enough
  let failed = false;

  // 1. Patches: each script exits non-zero without touching files when its target does not match. What it wrote is
  // in its output (`<name>: changed <file>`), and that decides the restart, not the patch's declared targets.
  docker(['exec', '-u', '0', container, 'rm', '-rf', PATCH_DIR]);
  docker(['cp', join(root, 'patches'), `${container}:${PATCH_DIR}`]);
  for (const file of readdirSync(join(root, 'patches')).filter(f => /^patch-.*\.js$/.test(f)).sort()) {
    try {
      const out = docker(['exec', '-u', '0', container, 'node', `${PATCH_DIR}/${file}`]);
      log(out.split('\n').join(' | ')); // each line already starts with the patch name
      const written = changedFiles(out);
      if (written.length) {
        if (needsRestart(written.map(f => ({ file: f })))) changed = true;
        else browserOnly.push(file.replace(/\.js$/, ''));
      }
    } catch (err) {
      failed = true;
      error(`${file}: FAILED. ${(err.stderr || err.message).toString().trim().split('\n')[0]}`);
    }
  }

  // 1b. Fane's shared, image, article, code and brainstorming modules, used by patch-image-chat, patch-article-chat,
  // patch-code-chat and patch-brainstorm-chat from inside Vane (the article and code folders also hold their
  // trial.json). Node caches imported modules, so a changed copy needs the restart below.
  try {
    for (const [name, dest] of [['core', FANE_CORE_DIR], ['image', FANE_IMAGE_DIR], ['write', FANE_WRITE_DIR], ['code', FANE_CODE_DIR], ['brainstorm', FANE_BRAINSTORM_DIR]]) {
      const keep = (f) => f.endsWith('.mjs') || f.endsWith('.json');
      const local = Object.fromEntries(readdirSync(join(root, 'cli', name)).filter(keep).sort()
        .map(f => [f, createHash('sha256').update(readFileSync(join(root, 'cli', name, f))).digest('hex')]));
      let remote = {};
      try {
        remote = JSON.parse(docker(['exec', container, 'node', '-e', `const fs=require('fs'),c=require('crypto'),d=${JSON.stringify(dest)};const o={};try{for(const f of fs.readdirSync(d).filter(f=>f.endsWith('.mjs')||f.endsWith('.json')).sort())o[f]=c.createHash('sha256').update(fs.readFileSync(d+'/'+f)).digest('hex')}catch{}console.log(JSON.stringify(o))`]));
      } catch { /* treat as missing */ }
      if (JSON.stringify(local) === JSON.stringify(remote)) log(`cli/${name}: already in ${dest}`);
      else {
        docker(['exec', '-u', '0', container, 'sh', '-c', `rm -rf ${dest} && mkdir -p ${dirname(dest)}`]);
        docker(['cp', join(root, 'cli', name), `${container}:${dest}`]);
        changed = true; // only after the copy: a failed copy is reported below and the next run copies again
        log(`cli/${name}: copied to ${dest}`);
      }
    }

    // 2. SearXNG settings. The secret_key is generated per install and the CORE key comes from the
    // environment; neither is written to the repo or printed.
    if (withSearxng) {
      const repoText = readFileSync(join(root, 'searxng', 'settings.yml'), 'utf8');
      const engineKeys = {};
      for (const e of KEYED_ENGINES) {
        const key = env[e.env]?.trim();
        if (!key) continue;
        try { renderSettings(repoText, { [e.opt]: key }); engineKeys[e.opt] = key; } catch (err) {
          error(`searxng/settings.yml: ${err.message}; the ${e.label} engine stays off`);
        }
      }
      const wanted = renderSettings(repoText, engineKeys);
      const keys = KEYED_ENGINES.map(e => `${e.label} ${engineKeys[e.opt] ? 'on' : 'off'}`).join(', ');
      const norm = (s) => s.replace(/\r\n/g, '\n').replace(SECRET_KEY_LINE, '$1 X').trim();
      let current = '';
      try { current = docker(['exec', container, 'cat', SETTINGS_PATH]); } catch { /* treat as different */ }
      if (norm(current) === norm(wanted)) {
        log(`searxng/settings.yml: already applied (${keys})`);
      } else {
        const dir = mkdtempSync(join(tmpdir(), 'fane-'));
        try {
          const tmp = join(dir, 'settings.yml');
          writeFileSync(tmp, renderSettings(repoText, { ...engineKeys, secretKey: randomBytes(32).toString('hex') }));
          docker(['cp', tmp, `${container}:${SETTINGS_PATH}`]);
          changed = true; // the file is in place even if the chown below fails
          docker(['exec', '-u', '0', container, 'chown', 'searxng:searxng', SETTINGS_PATH]);
          log(`searxng/settings.yml: applied with a new random secret_key (${keys}; set ${KEYED_ENGINES.map(e => e.env).join(', ')} to switch an engine on)`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    failed = true;
    error(`apply: ${(err.stderr || err.message).toString().trim().split('\n')[0]}`);
  }

  // 3. Restart only if something changed, then wait for the API.
  if (changed) {
    docker(['restart', container]);
    log(await waitReady(url, write) ? ' ready' : ' not ready after 90s');
  } else if (browserOnly.length) {
    log(`only browser files changed (${browserOnly.join(', ')}); not restarting: reload the page`);
  } else {
    log('nothing changed; not restarting');
  }

  // 4. Verify.
  return failed || doctor() ? 1 : 0;
}

// Run only when executed, not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  applyFane({ argv: process.argv.slice(2) }).then(code => { process.exitCode = code; }, err => {
    console.error(`apply: ${(err.stderr || err.message).toString().trim().split('\n')[0]}`);
    process.exitCode = 1;
  });
}
