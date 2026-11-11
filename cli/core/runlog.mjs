// What a web request leaves in the log: its lines share a short id, and a finished run writes one JSON summary.
// Pure apart from the id and the clock. Shared by every feature's hook, so it lives in core.
import { createHash, randomUUID } from 'node:crypto';
import { STOPPED_STATUS, outcomeOf } from './outcome.mjs';

export { STOPPED_STATUS }; // moved to outcome.mjs; old importers keep working

// A short fingerprint of a feature's prompts (an object of builders and strings): it changes when one is edited,
// so a log line says which prompts a run used.
export const promptVersion = (prompts) => createHash('sha1').update(Object.values(prompts).map(String).join('|')).digest('hex').slice(0, 8);

// One JSON line for a finished run: the feature, how it ended, what it cost and how long each phase took.
// `r` is a pipeline result ({ ok, status, mode, reasoning, calls, cost, phases, degraded }); `outcome` says how it ended
// (outcome.mjs), `degraded` how many notes a finished run carries, and a stopped run (browser closed, time limit) keeps its `stopped` key.
export const runSummary = (feature, r, { id, ms, prompts } = {}) => JSON.stringify({
  run: id,
  feature,
  ok: !!r.ok,
  outcome: outcomeOf(r),
  ...(r.status === STOPPED_STATUS && { stopped: true }),
  ...(r.degraded?.length && { degraded: r.degraded.length }),
  ...(r.mode && { mode: r.mode }),
  ...(r.reasoning && { reasoning: r.reasoning }),
  ms,
  ...(r.calls != null && { calls: r.calls }),
  ...(typeof r.cost === 'number' && { cost: Number(r.cost.toFixed(4)) }),
  ...(prompts && { prompts: promptVersion(prompts) }),
  phases: (r.phases || []).map(p => `${p.phase}${p.file ? `:${p.file}` : ''}=${p.status}/${p.ms ?? 0}ms`),
});

// The bookkeeping of one web request: every line it logs carries the same short id, and finish(result) writes the summary.
export function beginRun(feature, log, prompts) {
  const id = randomUUID().slice(0, 8), started = Date.now();
  const tagged = (m) => log(`[${id}] ${m}`);
  return { id, log: tagged, finish: (r) => tagged(runSummary(feature, r, { id, ms: Date.now() - started, prompts })) };
}
