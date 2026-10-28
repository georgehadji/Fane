// Vane: coding requests in the web UI. "write a Python script that ..." / «γράψε ένα πρόγραμμα που ...» got a
// short research answer. Before classification, next to the image and article hooks, the chat route now hands
// the message to Fane's coding pipeline (cli/code/vane-hook.mjs, mounted at FANE_CODE_DIR); for a coding request
// it answers with the files, the review and the tests and ends the turn, otherwise Vane continues as usual. If the
// hook is missing or throws, Vane continues as usual too. `research` is the article hook's: Vane's own research
// class on this chat's model and mode, used for documentation and for known vulnerabilities of the stack.
//
// The browser code that shows answers rewrites every "[x]" of the text: into citation chips when the answer has
// sources, and "[1]" into nothing when it has none. In code that breaks a[0], [a, b] and the like, so the second
// target leaves an answer alone when it contains CODE_ANSWER_MARKER (cli/code/present.mjs ends every answer of the
// hook with it). That chunk is served with max-age=0: a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { FILES, CONFIG_JSON, FANE_CODE_DIR, CODE_ANSWER_MARKER } = require('./lib/vane');
const { FINISH } = require('./patch-image-chat');
const { CLASSIFY, RESEARCH } = require('./patch-article-chat');

const HOOK = `if(await(async()=>{try{let H=await import(${JSON.stringify(`file://${FANE_CODE_DIR}/vane-hook.mjs`)});return await H.handleCodeRequest(b.followUp,{mode:b.config.mode,configPath:${JSON.stringify(CONFIG_JSON)},research:${RESEARCH},researchDone:()=>a.emit("data",{type:"researchComplete"}),emit:x=>{let B={id:crypto.randomUUID(),type:"text",data:x};a.emitBlock(B);return B.id},update:(I,x)=>{let B=a.getBlock(I);B&&(B.data=x,a.updateBlock(I,[{op:"replace",path:"/data",value:x}]))}})}catch(E){console.log("fane: code hook unavailable:",E&&E.message);return!1}})()){${FINISH};return}/*fane:code-chat*/`;

// In ChatProvider: `s` is a text block's data and `l` the answer's sources.
const CITATIONS = 's=l.length>0?s.replace(/\\[([^\\]]+)\\]/g,';

const TARGETS = [
  {
    name: 'coding requests answered with code',
    file: FILES.chatRoute,
    from: CLASSIFY,
    to: HOOK + CLASSIFY,
    marker: '/*fane:code-chat*/',
  },
  {
    name: 'code answers keep their brackets',
    file: FILES.chatClient,
    from: CITATIONS,
    to: `s=s.includes(${JSON.stringify(CODE_ANSWER_MARKER)})?s:${CITATIONS.slice(2)}`,
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-code-chat', TARGETS);
