// Vane: article requests in the web UI. "write an article about ..." / "γράψε ένα άρθρο για ..." got
// a short research answer. Before classification, next to the image hook, the chat route now hands
// the message to Fane's article pipeline (cli/write/vane-hook.mjs, mounted at FANE_WRITE_DIR); for an
// article request it answers with the article and ends the turn, otherwise Vane continues as usual.
// If the hook is missing or throws, Vane continues as usual too.
// The pipeline needs sources. `research` runs Vane's own research class on this chat's model and
// mode (the classifier first, as in Vane's own flow), so the user sees Vane's usual research
// progress and no second search stack is involved. `researchDone` closes that display.
// The patch inserts before Vane's classification step, which patch-image-chat also anchors on, so
// the two work in either order; each leaves its own marker.
const { run } = require('./lib/apply-targets');
const { FILES, CONFIG_JSON, FANE_WRITE_DIR } = require('./lib/vane');
const { FINISH, LAST_ANSWER } = require('./patch-image-chat');

const CLASSIFY = 'let d=await (0,e.L)({chatHistory:b.chatHistory,enabledSources:b.config.sources,query:b.followUp,llm:b.config.llm}),l=h.u.executeAll(';

// In scope here (the chat route's search function): a = the session, b = its options, e.L = the
// classifier, f.A = the research class, i.A / j = the database. `C` and `R` are new names.
const RESEARCH = 'async q=>{let C=await (0,e.L)({chatHistory:[],enabledSources:b.config.sources,query:q,llm:b.config.llm});C.classification.skipSearch=!1;let R=await new f.A().research(a,{chatHistory:[],followUp:q,classification:C,config:b.config});return((R&&R.searchFindings)||[]).map(s=>({title:(s.metadata&&s.metadata.title)||"",url:(s.metadata&&s.metadata.url)||"",content:s.content||""}))}';

const HOOK = `if(await(async()=>{try{let H=await import(${JSON.stringify(`file://${FANE_WRITE_DIR}/vane-hook.mjs`)});return await H.handleArticleRequest(b.followUp,{lastAnswer:${LAST_ANSWER},history:b.chatHistory,mode:b.config.mode,configPath:${JSON.stringify(CONFIG_JSON)},research:${RESEARCH},researchDone:()=>a.emit("data",{type:"researchComplete"}),emit:x=>{let B={id:crypto.randomUUID(),type:"text",data:x};a.emitBlock(B);return B.id},update:(I,x)=>{let B=a.getBlock(I);B&&(B.data=x,a.updateBlock(I,[{op:"replace",path:"/data",value:x}]))}})}catch(E){console.log("fane: article hook unavailable:",E&&E.message);return!1}})()){${FINISH};return}/*fane:article-chat*/`;

const TARGETS = [
  {
    name: 'article requests answered with articles',
    file: FILES.chatRoute,
    from: CLASSIFY,
    to: HOOK + CLASSIFY,
    marker: '/*fane:article-chat*/',
  },
  {
    // Upgrade for a hook installed before follow-up edits: hand over the previous answer and the history.
    name: 'article hook can read the previous answer',
    file: FILES.chatRoute,
    from: 'handleArticleRequest(b.followUp,{mode:b.config.mode,configPath:',
    to: `handleArticleRequest(b.followUp,{lastAnswer:${LAST_ANSWER},history:b.chatHistory,mode:b.config.mode,configPath:`,
  },
];

module.exports = { TARGETS, CLASSIFY, RESEARCH };
if (require.main === module) run('patch-article-chat', TARGETS);
