// Vane: brainstorm requests in the web UI. "brainstorm ...", "give me 10 ideas for ..." / «δώσε μου ιδέες για ...»
// got a short research answer. Before classification, next to the image, article and code hooks, the chat route
// now hands the message to Fane's brainstorming pipeline (cli/brainstorm/vane-hook.mjs, mounted at
// FANE_BRAINSTORM_DIR); for a brainstorm request it answers with ranked, developed ideas and a recommendation and
// ends the turn, otherwise Vane continues as usual. If the hook is missing or throws, Vane continues as usual too.
// `research` is the article hook's: Vane's own research class on this chat's model and mode, used here to find
// what already exists.
const { run } = require('./lib/apply-targets');
const { FILES, CONFIG_JSON, FANE_BRAINSTORM_DIR } = require('./lib/vane');
const { FINISH } = require('./patch-image-chat');
const { CLASSIFY, RESEARCH } = require('./patch-article-chat');

const HOOK = `if(await(async()=>{try{let H=await import(${JSON.stringify(`file://${FANE_BRAINSTORM_DIR}/vane-hook.mjs`)});return await H.handleBrainstormRequest(b.followUp,{mode:b.config.mode,configPath:${JSON.stringify(CONFIG_JSON)},research:${RESEARCH},researchDone:()=>a.emit("data",{type:"researchComplete"}),emit:x=>{let B={id:crypto.randomUUID(),type:"text",data:x};a.emitBlock(B);return B.id},update:(I,x)=>{let B=a.getBlock(I);B&&(B.data=x,a.updateBlock(I,[{op:"replace",path:"/data",value:x}]))}})}catch(E){console.log("fane: brainstorm hook unavailable:",E&&E.message);return!1}})()){${FINISH};return}/*fane:brainstorm-chat*/`;

const TARGETS = [
  {
    name: 'brainstorm requests answered with ideas',
    file: FILES.chatRoute,
    from: CLASSIFY,
    to: HOOK + CLASSIFY,
    marker: '/*fane:brainstorm-chat*/',
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-brainstorm-chat', TARGETS);
