// One chat turn of a web hook (article, code, brainstorm, image): the answer block it emits, the updates it sends
// while the work goes, and the one summary line it leaves behind. Each hook decides whether a message is its own
// (it returns false before creating a turn) and how its answer looks; the lifecycle is here so the four copies cannot
// drift. Imports only core; the hook injects `tag` (its answer marker) and `prompts` (for the log fingerprint).
import { beginRun } from './runlog.mjs';

// Phase events that are not records of a finished phase: a phase starting, a draft to show, the run's own end.
const NOT_A_RECORD = new Set(['running', 'preview']);

export function createTurn({ feature, prompts, emit, update, log, tag = (m) => m }) {
  const track = beginRun(feature, log, prompts);
  log = track.log;
  let id, queue = Promise.resolve(), finished = false, cost;
  const phases = [];

  // Once the answer exists the hook owns the turn: a failing update must never throw into Vane's chat route.
  const say = (markdown) => { try { update(id, tag(markdown)); } catch (err) { log(`could not update the answer: ${err.message}`); } };

  // The summary line, once. A second call (a hook finishing early, then run's own) is ignored.
  const finish = (result) => {
    if (finished) return;
    finished = true;
    track.finish(result);
  };

  // handle(event) mutates the hook's state at once and returns what to show: nothing, or a function that renders
  // the answer (it may be async). The renders run one at a time, in event order. Phases and cost are noted for a throw.
  const progress = (handle) => (e) => {
    if (e?.phase && e.phase !== 'done' && !NOT_A_RECORD.has(e.status)) {
      const at = phases.findIndex(p => p.phase === e.phase && p.file === e.file);
      const rec = { phase: e.phase, ...(e.file && { file: e.file }), status: e.status, ...(e.ms != null && { ms: e.ms }) };
      if (at < 0) phases.push(rec); else phases[at] = rec;
    }
    const render = handle(e);
    // A render that throws is logged and skipped: left rejected, it would end every later update and go unhandled.
    if (render) queue = queue.then(async () => say(await render())).catch((err) => log(`could not render the progress: ${err.message}`));
  };
  const spend = (usd) => { cost = (cost || 0) + usd; };
  const settle = () => queue;

  // Emits the first answer, then runs fn. fn returns the pipeline result (or nothing when it ends early: the summary
  // says ok: false). A throw becomes a failed run that keeps the phases and cost seen so far; `failed(err)` is where the
  // hook logs and shows its message. The summary is written on every path.
  async function run(first, fn, { failed } = {}) {
    id = emit(tag(first)); // a failing emit propagates, as before: there is no answer block to own yet
    let result = { ok: false };
    try {
      result = (await fn()) ?? result;
    } catch (err) {
      try { await queue; } catch { /* the failure itself is the answer */ }
      result = { ok: false, error: err.message, phases, ...(cost != null && { cost }) };
      failed?.(err);
    } finally {
      finish(result);
    }
  }

  return { log, say, progress, spend, settle, finish, run };
}
