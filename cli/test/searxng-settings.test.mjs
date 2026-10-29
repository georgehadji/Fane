import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { renderSettings } = await import('../../scripts/searxng-settings.mjs');
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
test('docker/fane-entrypoint.sh renders the same CORE block as renderSettings', { skip: spawnSync('sh', ['-c', 'true']).status !== 0 && 'no sh' }, () => {
  const script = readFileSync(new URL('../../docker/fane-entrypoint.sh', import.meta.url), 'utf8');
  const sed = /sed -i "([^"]+)"/.exec(script)[1].replace('$CORE_API_KEY', KEY);
  const r = spawnSync('sh', ['-c', `sed "${sed}"`], { input: repo.replace(/\r\n/g, '\n'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd(), renderSettings(repo, { coreKey: KEY }).trimEnd());
});

test('docker/fane-entrypoint.sh refuses the same keys as renderSettings, a newline included', { skip: spawnSync('sh', ['-c', 'true']).status !== 0 && 'no sh' }, () => {
  const script = readFileSync(new URL('../../docker/fane-entrypoint.sh', import.meta.url), 'utf8');
  const check = /case "\$CORE_API_KEY" in[\s\S]*?\n {2}esac/.exec(script)[0];
  const accepts = (key) => spawnSync('sh', ['-c', `${check}\necho "$ok"`], { env: { ...process.env, CORE_API_KEY: key }, encoding: 'utf8' }).stdout.trim() === 'yes';
  assert.equal(accepts(KEY), true);
  for (const bad of ["abc'def123", 'abc def123', 'short', 'a'.repeat(201), `${KEY}\nx: y`, `${KEY}\n`]) assert.equal(accepts(bad), false, JSON.stringify(bad));
});

test('docker/fane-entrypoint.sh trims a pasted key like apply.mjs does, and still refuses a space inside it', { skip: spawnSync('sh', ['-c', 'true']).status !== 0 && 'no sh' }, () => {
  const script = readFileSync(new URL('../../docker/fane-entrypoint.sh', import.meta.url), 'utf8');
  const trim = script.split('\n').filter(l => l.startsWith('CORE_API_KEY=')).join('\n');
  assert.equal(trim.split('\n').length, 3);
  const check = /case "\$CORE_API_KEY" in[\s\S]*?\n {2}esac/.exec(script)[0];
  const sh = (key, tail) => spawnSync('sh', ['-c', `${trim}\n${tail}`], { env: { ...process.env, CORE_API_KEY: key }, encoding: 'utf8' }).stdout;
  const trimmed = (key) => sh(key, 'printf "%s" "$CORE_API_KEY"');
  const accepts = (key) => sh(key, `${check}\necho "$ok"`).trim() === 'yes';
  for (const messy of [`${KEY} `, `${KEY}\r\n`, ` \t${KEY}\r`, `\n${KEY}`, `  ${KEY}  `]) {
    assert.equal(trimmed(messy), KEY, JSON.stringify(messy));
    assert.equal(accepts(messy), true, JSON.stringify(messy)); // the same settings as the clean key
  }
  assert.equal(trimmed('abc def123'), 'abc def123');
  for (const bad of ['abc def123', `${KEY}\nx: y`, 'short ']) assert.equal(accepts(bad), false, JSON.stringify(bad));
  assert.equal(trimmed(''), ''); // no key: nothing to render
});
