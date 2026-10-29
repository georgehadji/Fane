// Vane: Quality answers are checked against their sources before they are shown. In Quality mode the writer's stream
// is collected instead of shown as it arrives, cli/write/quality-check.mjs (mounted at FANE_WRITE_DIR) checks every
// cited sentence against the sources it cites with one call on the chat's model, corrects or removes what they do not
// state, and the checked answer is shown at once. The web UI adds a status line with the counts; /api/search (the CLI)
// gets the answer alone. If the module is missing or throws, the answer is shown as written. Speed and Balanced
// stream as before.
const { run } = require('./lib/apply-targets');
const { FILES, FANE_WRITE_DIR } = require('./lib/vane');

// `S` is the writer's stream, `b` the search input; `findings` are the sources the answer's [n] cite (n - 1).
const wrap = (findings, web) => `(S=>"quality"!==b.config.mode?S:(async function*(){/*fane:quality-check*/let A="";for await(let x of S)A+=x.contentChunk;try{let H=await import(${JSON.stringify(`file://${FANE_WRITE_DIR}/quality-check.mjs`)});A=await H.checkAnswer(A,{sources:${findings}||[],llm:b.config.llm,web:${web}})}catch(E){console.log("fane: quality check unavailable:",E&&E.message)}yield{contentChunk:A}})())(`;

const WRITER = 'b.config.llm.streamText({messages:[{role:"system",content:SYSTEM},...b.chatHistory,{role:"user",content:b.followUp}]})';
const writer = (system) => WRITER.replace('SYSTEM', system);

const TARGETS = [
  {
    // chat route: o = the research result, s = the writer prompt
    name: 'web answer checked before it is shown',
    file: FILES.chatRoute,
    from: `t=${writer('s')},u="";`,
    to: `t=${wrap('o?.searchFindings', '!0')}${writer('s')}),u="";`,
    marker: '/*fane:quality-check*/', // patch-sources-required rewrites the writer call inside `to`
  },
  {
    // search route (the CLI): l = the research result, p = the writer prompt
    name: 'API answer checked before it is returned',
    file: FILES.searchRoute,
    from: `for await(let c of ${writer('p')})`,
    to: `for await(let c of ${wrap('l?.searchFindings', '!1')}${writer('p')}))`,
    marker: '/*fane:quality-check*/',
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-quality-check', TARGETS);
