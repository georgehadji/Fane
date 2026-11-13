// Vane: always run web research, in both the agent API (/api/search, used by
// the `vane` CLI) and the web UI (/api/chat).
// Upstream, a classifier may set skipSearch=true for "general knowledge"
// questions, but the writer only answers from search results, so the reply
// becomes "could not find any relevant information".
// Except for a message that is only a greeting, thanks or goodbye (SMALLTALK in lib/vane.js): "hello" was researched
// as a topic and answered with an essay. Those skip the research, and patch-sources-required answers them with a
// fixed line, so no search runs and no model is called.
const { run } = require('./lib/apply-targets');
const { FILES, SMALLTALK_SOURCE } = require('./lib/vane');

// skipSearch is true for small talk and false otherwise; `q` is the route's question (b.followUp in both routes).
const skip = (v, q) => `(${v}.classification.skipSearch=!!(${SMALLTALK_SOURCE})(${q}))`;

const TARGETS = [
  {
    name: 'always search (/api/search)',
    file: FILES.searchRoute,
    alts: [
      { from: 'c.classification.skipSearch||(j=new g.A().research(', to: `${skip('c', 'b.followUp')}||(j=new g.A().research(` },
      { from: '(c.classification.skipSearch=!1)||(j=new g.A().research(', to: `${skip('c', 'b.followUp')}||(j=new g.A().research(` },
    ],
    ladder: ['fresh', 'V1'],
  },
  {
    name: 'always search (/api/chat)',
    file: FILES.chatRoute,
    alts: [
      { from: 'd.classification.skipSearch||(m=new f.A().research(', to: `${skip('d', 'b.followUp')}||(m=new f.A().research(` },
      { from: '(d.classification.skipSearch=!1)||(m=new f.A().research(', to: `${skip('d', 'b.followUp')}||(m=new f.A().research(` },
    ],
    ladder: ['fresh', 'V1'],
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-always-search', TARGETS);
