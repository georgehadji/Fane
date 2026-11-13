// Vane: X posts from xAI's x_search tool in the Social source. patch-social-sources already searches site:x.com on web
// engines, which index few posts; here the social_search tool also asks Grok to search X (cli/write/xsearch.mjs,
// imported at runtime from FANE_WRITE_DIR like the hooks, so it is one implementation and one set of tests). The call
// runs inside the tool's own Promise.all, next to the forum and site searches. It needs an OpenAI-compatible provider
// with Base URL https://api.x.ai/v1 in Vane's Settings -> Models: without one searchX returns [] at once and costs
// nothing. With one, each research may make at most FANE_X_MAX_CALLS (2) calls, $5 per 1,000 posts fetched plus tokens.
// If the module is missing or throws, the tool answers as before. A server route chunk: needs Vane restarted.
// Runs after patch-social-sources (file order) and edits its output: that patch's search target carries a marker that
// x-search leaves alone, or re-running it would fail with "found 0".
const { run } = require('./lib/apply-targets');
const { FILES, CONFIG_JSON, FANE_WRITE_DIR } = require('./lib/vane');

// `a` is the tool's input and `c` the research block, both in scope where patch-social-sources builds its searches.
// No backticks in injected code.
// `b.mode` is Vane's own mode (speed, balanced or quality); searchX takes its cap from it (Speed makes no call).
const CALL = `(async()=>{try{return(await(await import(${JSON.stringify(`file://${FANE_WRITE_DIR}/xsearch.mjs`)})).searchX({queries:a.queries,block:c,mode:b.mode,configPath:${JSON.stringify(CONFIG_JSON)}}))||[]}catch(E){return[]}})()`;
// The first version, in containers patched before the mode was passed (an upgrade `alts` entry below).
const CALL_V1 = `(async()=>{try{return(await(await import(${JSON.stringify(`file://${FANE_WRITE_DIR}/xsearch.mjs`)})).searchX({queries:a.queries,block:c,configPath:${JSON.stringify(CONFIG_JSON)}}))||[]}catch(E){return[]}})()`;

// patch-social-sources' own X filter, which ends the list the tool returns.
const X_FILTER = 'x=>/^https?:\\/\\/(?:(?:www|mobile)\\.)?(?:x|twitter)\\.com\\/\\w+\\/status\\/\\d+/.test(String(x.metadata&&x.metadata.url))';

const TARGETS = [
  {
    name: 'x_search runs with the other social searches',
    alts: [
      { from: '[F,R,X]=await Promise.all([', to: `[XA,F,R,X]=await Promise.all([${CALL},` },
      { from: `[XA,F,R,X]=await Promise.all([${CALL_V1},`, to: `[XA,F,R,X]=await Promise.all([${CALL},` },
    ],
    ladder: ['fresh+social-sources', 'V1'],
  },
  {
    name: 'x_search posts join the social results',
    from: `...X.filter(${X_FILTER})]})()}`,
    to: `...X.filter(${X_FILTER}),...XA]})()}`,
  },
].map(t => ({ file: FILES.research, ...t }));

module.exports = { TARGETS, CALL, CALL_V1 };
if (require.main === module) run('patch-x-search', TARGETS);
