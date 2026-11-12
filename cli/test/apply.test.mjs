import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/apply.mjs driven by a fake docker: the real one never runs here, and nothing touches a container.
const require = createRequire(import.meta.url);
const { applyFane, changedFiles, managedByCompose } = await import('../../scripts/apply.mjs');
const { KEYED_ENGINES, renderSettings } = await import('../../scripts/searxng-settings.mjs');
const { FILES, FANE_CORE_DIR, FANE_IMAGE_DIR, FANE_WRITE_DIR, FANE_CODE_DIR, FANE_BRAINSTORM_DIR } = require('../../patches/lib/vane.js');

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DIRS = { core: FANE_CORE_DIR, image: FANE_IMAGE_DIR, write: FANE_WRITE_DIR, code: FANE_CODE_DIR, brainstorm: FANE_BRAINSTORM_DIR };
const repoSettings = readFileSync(join(ROOT, 'searxng', 'settings.yml'), 'utf8');
const KEY = 'AbC123def456GhI789';
const PLAIN = '[]'; // a `docker run` container: no /fane mounts
const COMPOSE_ENTRYPOINT = '["sh","/fane/docker/fane-entrypoint.sh"]';
const COMPOSE_MOUNTS = '[{"Type":"bind","Source":"C:\\\\repo\\\\patches","Destination":"/fane/patches","Mode":"ro"}]';

const localHashes = (name) => JSON.stringify(Object.fromEntries(readdirSync(join(ROOT, 'cli', name)).filter(f => f.endsWith('.mjs') || f.endsWith('.json')).sort()
  .map(f => [f, createHash('sha256').update(readFileSync(join(ROOT, 'cli', name, f))).digest('hex')])));
const patched = (name, ...files) => [`${name}: patched 1 of 1 targets (1 changed now; backups: *.bak)`, ...files.map(f => `${name}: changed ${f}`)].join('\n');

// What each ordinary run needs from the container; every field is a deviation from "nothing to do".
//   inspect: the `docker inspect` answer; patches: { 'patch-x.js': output }; failPatch: a patch that exits non-zero;
//   stale: module folders whose copy in the container differs; failCopy: a folder whose docker cp throws;
//   settings: the container's settings.yml (default: exactly what this run would write); env: the host environment.
async function scenario({ inspect = `true@@${PLAIN}@@${PLAIN}`, patches = {}, failPatch, stale = [], failCopy, settings, env = {}, argv = [] } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  let copied = null;
  const keys = Object.fromEntries(KEYED_ENGINES.filter(e => env[e.env]).map(e => [e.opt, env[e.env].trim()]));
  const docker = (args) => {
    calls.push(args);
    if (args[0] === 'inspect') return inspect;
    if (args[0] === 'exec' && args.includes('-e')) {
      const name = Object.keys(DIRS).find(n => args.at(-1).includes(JSON.stringify(DIRS[n])));
      return stale.includes(name) ? '{}' : localHashes(name);
    }
    if (args[0] === 'exec' && args[5]?.startsWith('/tmp/fane-patches/')) {
      const file = basename(args[5]);
      if (file === failPatch) throw Object.assign(new Error('exit 1'), { stderr: `${file.replace('.js', '')}: expected 1 match, found 0\n` });
      return patches[file] ?? `${file.replace('.js', '')}: already patched`;
    }
    if (args[0] === 'exec' && args.at(-2) === 'cat') return settings ?? renderSettings(repoSettings, { ...keys, secretKey: 'x'.repeat(64) });
    if (args[0] === 'cp' && args[2].endsWith(':/etc/searxng/settings.yml')) copied = readFileSync(args[1], 'utf8');
    if (args[0] === 'cp' && failCopy && args[1].endsWith(join('cli', failCopy))) throw Object.assign(new Error('copy'), { stderr: 'no space left\n' });
    return '';
  };
  const code = await applyFane({ docker, env, argv, container: 'vane', url: 'http://127.0.0.1:3000', log: (s) => out.push(s), error: (s) => err.push(s), write: () => {}, waitReady: async () => true, doctor: () => 0 });
  return { code, calls, out, err, copied, restarted: calls.some(a => a[0] === 'restart'), text: out.join('\n') };
}

test('clean container: nothing written, nothing restarted, exit 0', async () => {
  const r = await scenario();
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(r.restarted, false);
  assert.match(r.text, /nothing changed; not restarting/);
  assert.equal(r.copied, null);
  assert.match(r.text, /searxng\/settings\.yml: already applied/);
});

test('only browser files written: reload message, no restart', async () => {
  const r = await scenario({ patches: { 'patch-colors.js': patched('patch-colors', FILES.appCss), 'patch-theme-toggle.js': patched('patch-theme-toggle', FILES.layoutClient, FILES.appCss) } });
  assert.equal(r.code, 0);
  assert.equal(r.restarted, false);
  assert.match(r.text, /only browser files changed \(patch-colors, patch-theme-toggle\); not restarting: reload the page/);
});

test('a server file written: restart; a patch that writes a server file and a browser file counts as server', async () => {
  const one = await scenario({ patches: { 'patch-always-search.js': patched('patch-always-search', FILES.searchRoute) } });
  assert.equal(one.restarted, true);
  assert.match(one.text, / ready$/);
  const mixed = await scenario({ patches: { 'patch-image-chat.js': patched('patch-image-chat', FILES.messageClient, FILES.chatRoute) } }); // one run() for patch-image-serve's files too
  assert.equal(mixed.restarted, true);
  assert.doesNotMatch(mixed.text, /only browser files/);
});

test('the decision reads the files written, not the "patched" words: a patched line with no "changed" line restarts nothing', async () => {
  const r = await scenario({ patches: { 'patch-always-search.js': patched('patch-always-search') } });
  assert.equal(r.restarted, false);
  assert.match(r.text, /nothing changed; not restarting/);
});

test('a module folder that differs is copied and restarts; a failed copy neither restarts nor passes', async () => {
  const r = await scenario({ stale: ['write'] });
  assert.equal(r.code, 0);
  assert.match(r.text, /cli\/write: copied to \/fane\/write/);
  assert.match(r.text, /cli\/core: already in/);
  assert.equal(r.restarted, true);
  const f = await scenario({ stale: ['image'], failCopy: 'image' });
  assert.equal(f.code, 1);
  assert.equal(f.restarted, false); // `changed` is set after a successful copy
  assert.match(f.err.join('\n'), /no space left/);
});

test('settings that differ are copied (secret_key is random) and restart', async () => {
  const r = await scenario({ settings: 'use_default_settings: true\n' });
  assert.equal(r.code, 0);
  assert.ok(r.copied?.includes('secret_key:'));
  assert.ok(r.calls.some(a => a.join(' ').endsWith('chown searxng:searxng /etc/searxng/settings.yml')));
  assert.equal(r.restarted, true);
  assert.match(r.text, /applied with a new random secret_key/);
  const no = await scenario({ settings: 'use_default_settings: true\n', argv: ['--no-searxng'] });
  assert.equal(no.copied, null); // --no-searxng leaves the file alone
  assert.equal(no.restarted, false);
});

test('host lacks a key the container has: the settings differ, so they are copied without the key and Vane restarts (as before Phase 9)', async () => {
  const withKey = renderSettings(repoSettings, { coreKey: KEY, secretKey: 'x'.repeat(64) }); // what Compose rendered
  const r = await scenario({ settings: withKey, env: {} });
  assert.equal(r.restarted, true);
  assert.ok(r.copied && !r.copied.includes(KEY));
  assert.match(r.text, /CORE off/);
  const same = await scenario({ settings: withKey, env: { CORE_API_KEY: ` ${KEY}\r\n` } }); // the key is there too: nothing to do
  assert.equal(same.restarted, false);
  assert.match(same.text, /CORE on/);
});

test('a Compose container is refused with exit 1 before anything is touched', async () => {
  for (const running of ['true', 'false']) {
    const r = await scenario({ inspect: `${running}@@${COMPOSE_ENTRYPOINT}@@${COMPOSE_MOUNTS}` });
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /managed by Compose.*docker compose restart vane/);
    assert.equal(r.calls.length, 1); // the inspect only: no exec, no cp, no restart
    assert.equal(r.out.length, 0);
  }
});

test('managedByCompose needs the Fane entrypoint and a /fane mount; a plain docker run container is not', () => {
  assert.equal(managedByCompose(COMPOSE_ENTRYPOINT, COMPOSE_MOUNTS), true);
  assert.equal(managedByCompose('null', PLAIN), false);
  assert.equal(managedByCompose('["/home/vane/entrypoint.sh"]', COMPOSE_MOUNTS), false);
  assert.equal(managedByCompose(COMPOSE_ENTRYPOINT, '[{"Destination":"/home/vane/data"}]'), false);
  assert.equal(managedByCompose('not json', 'null'), false);
});

test('a stopped container and a container docker cannot inspect are refused', async () => {
  const stopped = await scenario({ inspect: `false@@${PLAIN}@@${PLAIN}` });
  assert.equal(stopped.code, 1);
  assert.match(stopped.err.join('\n'), /is stopped\. Run: docker start vane/);
  assert.equal(stopped.calls.length, 1);
  const errs = [];
  const code = await applyFane({ container: 'vane', docker: () => { throw Object.assign(new Error('x'), { stderr: 'Error: No such object: vane\n' }); }, error: (s) => errs.push(s), log() {}, doctor: () => 0 });
  assert.equal(code, 1);
  assert.match(errs[0], /cannot inspect container "vane": Error: No such object: vane/);
});

test('a patch that fails is reported, the others still count, and the exit code is 1', async () => {
  const r = await scenario({ failPatch: 'patch-weather.js', patches: { 'patch-always-search.js': patched('patch-always-search', FILES.searchRoute) } });
  assert.equal(r.code, 1);
  assert.match(r.err.join('\n'), /patch-weather\.js: FAILED\. patch-weather: expected 1 match, found 0/);
  assert.equal(r.restarted, true);
});

test('the real docker is not run by importing the script, and --help prints usage and exits 0', async () => {
  const lines = [];
  assert.equal(await applyFane({ argv: ['--help'], log: (s) => lines.push(s), docker: () => assert.fail('docker must not run') }), 0);
  assert.match(lines[0], /^Usage: node scripts\/apply\.mjs/);
});

test('changedFiles reads the "<name>: changed <file>" lines and nothing else', () => {
  const out = ['patch-x: patched 2 of 2 targets (2 changed now; backups: *.bak)', 'patch-x: changed /home/vane/.next/server/a.js', 'patch-x: changed /home/vane/public/b.css', 'patch-x: skipped y (no)', 'patch-x: already patched'].join('\n');
  assert.deepEqual(changedFiles(out), ['/home/vane/.next/server/a.js', '/home/vane/public/b.css']);
  assert.deepEqual(changedFiles('patch-x: already patched'), []);
});
