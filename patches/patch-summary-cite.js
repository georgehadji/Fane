// Vane: the Σύνοψη of a summary always carries its citation.
// The writer's summary rule (patch-answer-language) asks for [1] at the end of the «Σύνοψη» paragraph, and a free model
// (freellmapi's auto:fast) left it out once, so the first thing the reader sees has no source chip. After
// patch-summary-source a summary has exactly one source, so the rule is deterministic: code can write the citation itself.
// CITE_SUMMARY(text, query, sourceCount, parse) is applied to every text block of the chat in the browser chunk that holds
// ChatProvider (FILES.chatClient, served with max-age=0: a reload picks it up, no restart), before Vane's own `[x]` rewrite,
// so the added [1] becomes a chip like any other. It changes nothing unless the question is a summary question
// (SUMMARY_QUESTION), the answer has exactly one source, the «Σύνοψη» heading is there, its paragraph is complete (a
// later heading has arrived: a streaming prefix is left alone, so a [1] never flickers in and out) and that paragraph has
// no [n] of its own. It is idempotent: its output is its own fixed point.
// The message (`e`) is shadowed by the block inside `forEach(e=>…)`, so its query is taken in a variable first.
const { run } = require('./lib/apply-targets');
const { FILES, SUMMARY_QUESTION } = require('./lib/vane');

// Injected as source text: no imports, no closure, ASCII (the heading word is built from its char codes), no backticks.
function CITE_SUMMARY(text, query, sourceCount, parse) {
  if (typeof text !== 'string' || sourceCount !== 1 || !parse(query)) return text;
  var word = String.fromCharCode(931, 973, 957, 959, 968, 951);
  var head = new RegExp('^#{2,3}[ \\t]+' + word + '[ \\t]*:?[ \\t]*(\\r?\\n|$)', 'm').exec(text);
  if (!head) return text;
  var start = head.index + head[0].length;
  var next = /^#{1,6}[ \t]/m.exec(text.slice(start));
  if (!next) return text; // the paragraph may still be growing
  var section = text.slice(start, start + next.index);
  var body = section.replace(/\s+$/, '');
  if (!body.trim() || /\[\s*\d/.test(body)) return text;
  return text.slice(0, start) + body + ' [1]' + section.slice(body.length) + text.slice(start + next.index);
}

const DECLARE_FROM = 'S.map(e=>{let t=[],r="",a=!1,s=[],l=e.responseBlocks';
const DECLARE_TO = 'S.map(e=>{let FANE_Q=e.query,t=[],r="",a=!1,s=[],l=e.responseBlocks';
const USE_FROM = '{let s=e.data,d=/\\[(\\d+)\\]/g;';
const USE_TO = `{let s=(${CITE_SUMMARY})(e.data,FANE_Q,l.length,${SUMMARY_QUESTION}),d=/\\[(\\d+)\\]/g;`;

const TARGETS = [
  { name: 'summary: the message query is kept', file: FILES.chatClient, from: DECLARE_FROM, to: DECLARE_TO },
  { name: 'summary: the Synopsis paragraph gets its citation', file: FILES.chatClient, from: USE_FROM, to: USE_TO },
];

module.exports = { TARGETS, CITE_SUMMARY };
if (require.main === module) run('patch-summary-cite', TARGETS);
