// Runs a model-written duration.mjs against fixed cases for scripts/code-trial.mjs, in its own Node process: the
// permission model is on (no file writes, no child processes, no workers, file reads only in its temporary folder),
// it gets an empty environment (so no OPENROUTER_API_KEY), and a 10 s limit. It can still open network connections,
// including to Vane on 127.0.0.1 (whose /api/config holds the provider keys): Node 24's permission model has no
// network switch, so run a trial of untrusted models with Vane stopped or on a machine without it.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HARNESS = `const cases = JSON.parse(process.argv[2]);
let mod;
try { mod = await import('./duration.mjs'); } catch (e) { console.log(JSON.stringify({ loadError: String(e && e.message) })); process.exit(0); }
if (typeof mod.parseDuration !== 'function') { console.log(JSON.stringify({ loadError: 'no parseDuration export' })); process.exit(0); }
const results = cases.map(([input, want]) => {
  try { const got = mod.parseDuration(input); return { ok: typeof want === 'number' && got === want }; }
  catch (e) { return { ok: typeof want === 'string' && e instanceof globalThis[want] }; }
});
console.log(JSON.stringify({ results }));
`;

// cases: [[input, number | error class name]] -> { results: [{ ok }] } | { loadError }
export async function runCases(code, cases) {
  const dir = await mkdtemp(join(tmpdir(), 'fane-code-trial-'));
  try {
    await writeFile(join(dir, 'duration.mjs'), code);
    await writeFile(join(dir, 'harness.mjs'), HARNESS);
    const flag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
    const { stdout } = await run(process.execPath, [flag, `--allow-fs-read=${dir}`, join(dir, 'harness.mjs'), JSON.stringify(cases)], { env: {}, timeout: 10_000, windowsHide: true, maxBuffer: 1 << 20 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch (err) {
    return { loadError: err.killed ? 'timed out' : String(err.stderr || err.message).trim().split('\n')[0] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
