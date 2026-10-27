// Vane: always run web research, in both the agent API (/api/search, used by
// the `vane` CLI) and the web UI (/api/chat).
// Upstream, a classifier may set skipSearch=true for "general knowledge"
// questions, but the writer only answers from search results, so the reply
// becomes "could not find any relevant information".
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const TARGETS = [
  {
    name: 'always search (/api/search)',
    file: FILES.searchRoute,
    from: 'c.classification.skipSearch||(j=new g.A().research(',
    to: '(c.classification.skipSearch=!1)||(j=new g.A().research(',
  },
  {
    name: 'always search (/api/chat)',
    file: FILES.chatRoute,
    from: 'd.classification.skipSearch||(m=new f.A().research(',
    to: '(d.classification.skipSearch=!1)||(m=new f.A().research(',
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-always-search', TARGETS);
