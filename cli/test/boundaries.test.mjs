// The feature folders form layers: a folder imports only from the folders listed for it. Nothing enforced this
// before; the folder-level cycles write<->code and write<->brainstorm grew from single imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// core: pure shared code (language, formats, the request detectors). image: the OpenRouter adapter and
// presentation helpers every feature uses. write: the pipeline engine (llm, models, catalogue, checks) that code
// and brainstorm build on. code and brainstorm are siblings and must not know each other.
export const ALLOWED = {
  core: [],
  image: ['core'],
  write: ['core', 'image'],
  code: ['core', 'image', 'write'],
  brainstorm: ['core', 'image', 'write'],
};

const specifiers = (src) => [...src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map(m => m[1]);

test('each feature folder imports only from the folders below it', () => {
  const violations = [];
  for (const [folder, allowed] of Object.entries(ALLOWED)) {
    const dir = join(CLI, folder);
    for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs'))) {
      for (const spec of specifiers(readFileSync(join(dir, file), 'utf8'))) {
        const target = relative(CLI, resolve(dir, spec)).split(sep)[0];
        if (target !== folder && !allowed.includes(target)) violations.push(`${folder}/${file} imports ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('every folder under cli that has modules is listed in the layers', () => {
  const known = new Set([...Object.keys(ALLOWED), 'test']);
  const folders = readdirSync(CLI, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')).map(e => e.name);
  assert.deepEqual(folders.filter(f => !known.has(f)), []);
});

test('the command line is layered too: client.mjs imports neither runners.mjs nor vane.mjs, runners.mjs not vane.mjs', () => {
  const of = (f) => specifiers(readFileSync(join(CLI, f), 'utf8')).map(s => s.replace(/^\.\//, ''));
  assert.deepEqual(of('client.mjs').filter(s => ['runners.mjs', 'vane.mjs'].includes(s)), []);
  assert.deepEqual(of('runners.mjs').filter(s => s === 'vane.mjs'), []);
});
