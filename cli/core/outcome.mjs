// How a run ends and how a phase is recorded: one vocabulary for the write, code, brainstorm and image features.
// Pure; imports nothing. Results keep every field callers read today (ok, stopped, degraded, status, fatal):
// `outcomeOf` derives the name from them.

// A run whose browser closed or whose time ran out (cli/image/openrouter.mjs puts it on the error of every call).
export const STOPPED_STATUS = 499;

export const OUTCOME = Object.freeze({ complete: 'complete', degraded: 'degraded', stopped: 'stopped', failed: 'failed' });

// The status of a phase record (`phases[]`). A progress event also carries `{ status: 'done' }` (a search or the whole
// run finished); that is an event, never a record, and stays a literal in the pipelines.
export const PHASE = Object.freeze({ running: 'running', preview: 'preview', ok: 'ok', fallback: 'fallback', failed: 'failed', rejected: 'rejected', skipped: 'skipped' });

// A status code (499), an error or result with that `status`, or an error whose text starts with "stopped:".
export const isStopped = (x) => x === STOPPED_STATUS || x?.status === STOPPED_STATUS
  || /^stopped:/i.test(typeof x === 'string' ? x : String(x?.message ?? x?.error ?? ''));

// A pipeline result -> how the run ended. `degraded` is an ok run that carries notes, or that a provider refusal
// (402, the spend cap) cut after its output existed (`stopped: { status, error }`); the user's own stop is `stopped`.
export const outcomeOf = (r) => (r?.status === STOPPED_STATUS ? OUTCOME.stopped
  : !r?.ok ? OUTCOME.failed
    : r.degraded?.length || r.stopped ? OUTCOME.degraded : OUTCOME.complete);

// One phase record. A status outside PHASE is a bug (a misspelt string), so it throws.
export function phaseRecord(phase, status, extra = {}) {
  if (!Object.values(PHASE).includes(status)) throw new Error(`unknown phase status "${status}"`);
  return { phase, ...extra, status };
}
