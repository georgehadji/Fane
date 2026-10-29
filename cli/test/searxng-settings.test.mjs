import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { KEYED_ENGINES, renderSettings } = await import('../../scripts/searxng-settings.mjs');
const repo = readFileSync(new URL('../../searxng/settings.yml', import.meta.url), 'utf8');
const KEY = 'AbC123def456GhI789';

test('without a CORE key the engine stays off and only the secret_key changes', () => {
  const out = renderSettings(repo, { secretKey: 'f'.repeat(64) });
  assert.match(out, /secret_key: 'f{64}'/);
  assert.match(out, /- name: core\.ac\.uk\n {4}api_key: ''\n {4}inactive: true/);
});

test('a CORE key goes into the core.ac.uk block only, and switches it on', () => {
  const out = renderSettings(repo, { coreKey: KEY });
  assert.match(out, new RegExp(`- name: core\\.ac\\.uk\\n {4}api_key: '${KEY}'\\n {4}inactive: false`));
  assert.equal(out.split(KEY).length - 1, 1);
  assert.equal(out.replace(`'${KEY}'`, "''").replace('inactive: false', 'inactive: true'), repo.replace(/\r\n/g, '\n'));
});

test('a key that could break the YAML or the sed is refused', () => {
  for (const bad of ["abc'def123", 'abc/def123', 'abc def123', 'short', 'a$b{c}12345']) assert.throws(() => renderSettings(repo, { coreKey: bad }), /unexpected characters/, bad);
});

// The container entrypoint does the same with sed. Skipped where there is no sh (Windows without Git Bash).
test('a Brave key goes into the brave api header only, and switches that engine on', () => {
  const out = renderSettings(repo, { braveKey: KEY });
  assert.match(out, new RegExp(`- name: brave api\n(?: {4}[^\n]*\n)*? {6}X-Subscription-Token: '${KEY}'\n {4}inactive: false`));
  assert.equal(out.split(KEY).length - 1, 1);
  assert.equal(out.replace(`'${KEY}'`, "''").replace(/(brave api[\s\S]*?)inactive: false/, '$1inactive: true'), repo.replace(/\r\n/g, '\n'));
  assert.match(renderSettings(repo, { coreKey: KEY, braveKey: KEY }), /core\.ac\.uk[\s\S]*inactive: false[\s\S]*brave api[\s\S]*inactive: false/);
  assert.match(renderSettings(repo, {}), /X-Subscription-Token: ''\n {4}inactive: true/); // no key: off
});

test('a Brave key that could break the YAML or the sed is refused', () => {
  for (const bad of ["abc'def123", 'abc def123', 'short', 'a$b{c}12345']) assert.throws(() => renderSettings(repo, { braveKey: bad }), /BRAVE_API_KEY has unexpected characters/, bad);
});

test('a Tavily key goes into the tavily Authorization header after "Bearer ", and switches that engine on', () => {
  const out = renderSettings(repo, { tavilyKey: KEY });
  assert.match(out, new RegExp(`- name: tavily\n(?: {4}[^\n]*\n)*? {6}Authorization: 'Bearer ${KEY}'\n {4}inactive: false`));
  assert.equal(out.split(KEY).length - 1, 1);
  assert.equal(out.replace(`'Bearer ${KEY}'`, "''").replace(/(name: tavily[\s\S]*?)inactive: false/, '$1inactive: true'), repo.replace(/\r\n/g, '\n'));
  assert.match(renderSettings(repo, {}), /Authorization: ''\n {4}inactive: true/); // no key: off
  for (const bad of ["abc'def123", 'abc def123', 'short']) assert.throws(() => renderSettings(repo, { tavilyKey: bad }), /TAVILY_API_KEY has unexpected characters/, bad);
});

// The container entrypoint does the same with sed (switch_on). Skipped where there is no sh (Windows without Git Bash).
const NO_SH = spawnSync('sh', ['-c', 'true']).status !== 0 && 'no sh';
const script = readFileSync(new URL('../../docker/fane-entrypoint.sh', import.meta.url), 'utf8');
const SWITCH_ON = /^switch_on\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)[0];
const CALLS = script.match(/^switch_on ".*$/gm);
// Runs the entrypoint's switch_on calls on a copy of the repo file, with only `env`'s keys set.
// `eol`: Compose mounts searxng/ from the checkout, which has CRLF on Windows.
function entrypoint(env, eol = '\n') {
  const dir = mkdtempSync(join(tmpdir(), 'fane-'));
  const file = join(dir, 'settings.yml').replace(/\\/g, '/');
  try {
    writeFileSync(file, repo.replace(/\r?\n/g, eol));
    const keys = Object.fromEntries(KEYED_ENGINES.map(e => [e.env, '']));
    const r = spawnSync('sh', ['-c', `${SWITCH_ON.replaceAll('/etc/searxng/settings.yml', file)}${CALLS.join('\n')}`], { env: { ...process.env, ...keys, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { out: readFileSync(file, 'utf8'), err: r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('docker/fane-entrypoint.sh has one switch_on call per KEYED_ENGINES entry, with the same engine, field and prefix', () => {
  const calls = CALLS.map(l => /^switch_on "\$\{(\w+):-\}" (\w+) (\w+) '([^']*)' (\S+) '([^']*)'$/.exec(l).slice(1));
  assert.deepEqual(calls, KEYED_ENGINES.map(e => [e.env, e.env, e.label, e.name, e.field, e.prefix]));
});

test('docker/fane-entrypoint.sh renders the same blocks as renderSettings, one key or all of them', { skip: NO_SH }, () => {
  for (const e of KEYED_ENGINES) assert.equal(entrypoint({ [e.env]: KEY }).out.trimEnd(), renderSettings(repo, { [e.opt]: KEY }).trimEnd(), e.env);
  const all = Object.fromEntries(KEYED_ENGINES.map(e => [e.opt, KEY]));
  assert.equal(entrypoint(Object.fromEntries(KEYED_ENGINES.map(e => [e.env, KEY]))).out.trimEnd(), renderSettings(repo, all).trimEnd());
  assert.equal(entrypoint({}).out, repo.replace(/\r\n/g, '\n')); // no key: nothing changes
  const crlf = entrypoint(Object.fromEntries(KEYED_ENGINES.map(e => [e.env, KEY])), '\r\n').out;
  assert.equal(crlf.replace(/\r\n/g, '\n').trimEnd(), renderSettings(repo, all).trimEnd());
});

test('docker/fane-entrypoint.sh trims a pasted key like apply.mjs does, and refuses the keys renderSettings refuses', { skip: NO_SH }, () => {
  const clean = renderSettings(repo, { coreKey: KEY }).trimEnd();
  for (const messy of [`${KEY} `, `${KEY}\r\n`, ` \t${KEY}\r`, `\n${KEY}`, `  ${KEY}  `]) assert.equal(entrypoint({ CORE_API_KEY: messy }).out.trimEnd(), clean, JSON.stringify(messy));
  for (const bad of ["abc'def123", 'abc def123', 'short', 'short ', 'a'.repeat(201), `${KEY}\nx: y`, 'a$b{c}12345']) {
    const r = entrypoint({ CORE_API_KEY: bad });
    assert.equal(r.out, repo.replace(/\r\n/g, '\n'), JSON.stringify(bad));
    assert.match(r.err, /CORE_API_KEY has unexpected characters; the CORE engine stays off/, JSON.stringify(bad));
    assert.throws(() => renderSettings(repo, { coreKey: bad.trim() }), /unexpected characters/, JSON.stringify(bad));
  }
});
