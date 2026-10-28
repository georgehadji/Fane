// Vane: closing the tab did not stop Fane's pipelines. The chat route reacts to the request's abort by
// unsubscribing and closing the stream, but the search function it started (and with it a hook's paid
// model calls) never hears about it. The request's signal is now kept on the session (`o.faneSignal`), and
// each hook is handed it as `signal`: the hooks' OpenRouter client then refuses every further call and aborts
// the one in flight (cli/image/openrouter.mjs). The same client carries the time limit of one request
// (FANE_DEADLINE_MIN, 30 minutes by default).
// Runs after the four hook patches (file-name order), whose text it edits; a hook that is not installed is skipped.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// In the route's POST handler `a` is the request and `o` the session passed to the search function as `a`.
const SEARCH = 'return n.searchAsync(o,{chatHistory:m,';

const hook = (fn) => ({
  name: `${fn} receives the request's signal`,
  file: FILES.chatRoute,
  from: `${fn}(b.followUp,{`,
  to: `${fn}(b.followUp,{signal:a.faneSignal,`,
  optional: `${fn} hook not installed`,
});

const TARGETS = [
  {
    name: 'the session keeps the request signal',
    file: FILES.chatRoute,
    from: SEARCH,
    to: `return o.faneSignal=a.signal,${SEARCH.slice('return '.length)}`,
  },
  hook('handleArticleRequest'),
  hook('handleBrainstormRequest'),
  hook('handleCodeRequest'),
  hook('handleImageRequest'),
];

module.exports = { TARGETS };
if (require.main === module) run('patch-pipeline-abort', TARGETS);
