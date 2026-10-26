#!/usr/bin/env node
// Tests SearXNG engines one at a time from inside the Vane container and prints
// which return results from this network. Use it to decide what to enable in
// searxng/settings.yml. Each engine gets ONE query per run (1s apart), so do not
// loop it: repeated queries are what get an IP rate-limited.
//
//   node scripts/engine-check.mjs                  enabled general-category engines
//   node scripts/engine-check.mjs --engines bing,yandex,mojeek   specific engines (even disabled ones)
//   node scripts/engine-check.mjs --query "rust"    different test query (default: node js lts)
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { engines: { type: 'string' }, query: { type: 'string', default: 'node js lts' }, help: { type: 'boolean', short: 'h', default: false } } });
if (values.help) {
  console.log('Usage: node scripts/engine-check.mjs [--engines a,b,c] [--query <text>]\nEnv: VANE_CONTAINER (default vane)');
  process.exit(0);
}
const container = process.env.VANE_CONTAINER || 'vane';

// Runs inside the container, where SearXNG listens on localhost:8080.
const script = `
const wanted = ${JSON.stringify(values.engines ? values.engines.split(',').map(s => s.trim()).filter(Boolean) : null)};
const q = encodeURIComponent(${JSON.stringify(values.query)});
const base = 'http://localhost:8080';
(async () => {
  const cfg = await (await fetch(base + '/config')).json();
  const names = wanted || cfg.engines.filter(e => e.enabled && (e.categories || []).includes('general')).map(e => e.name);
  const out = [];
  for (const name of names) {
    try {
      const j = await (await fetch(base + '/search?q=' + q + '&format=json&engines=' + encodeURIComponent(name), { signal: AbortSignal.timeout(20000) })).json();
      const down = (j.unresponsive_engines || []).find(u => u[0] === name);
      out.push({ name, results: j.results.length, error: down ? down[1] : null });
    } catch (e) { out.push({ name, results: 0, error: String(e.message || e) }); }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(JSON.stringify(out));
})();`;

let rows;
try {
  rows = JSON.parse(execFileSync('docker', ['exec', container, 'node', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 }));
} catch (err) {
  console.error(`engine-check: ${(err.stderr || err.message).toString().trim().split('\n')[0]}`);
  process.exit(1);
}

for (const r of rows) console.log(`${(r.results > 0 ? 'ok' : 'FAIL').padEnd(4)}  ${r.name.padEnd(24)} ${String(r.results).padStart(3)} results${r.error ? `  (${r.error})` : ''}`);
const good = rows.filter(r => r.results > 0).map(r => r.name);
console.log(`\n${good.length}/${rows.length} engines returned results from this network.`);
if (values.engines && good.length) console.log(`To enable, add to searxng/settings.yml under engines:\n${good.map(n => `  - name: ${n}\n    disabled: false`).join('\n')}`);
