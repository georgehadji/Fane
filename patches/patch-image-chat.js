// Vane: image requests in the web UI. Vane's answer pipeline can only write text, so
// "create an image of Donald Duck in a playground" got "I can't create images". Before
// classification, the chat route now hands the message to Fane's image pipeline
// (cli/image/vane-hook.mjs, mounted at FANE_IMAGE_DIR); for an image request it answers with
// the generated images and ends the turn, otherwise Vane continues as usual. If the hook is
// missing or throws, Vane continues as usual too.
const { run } = require('./lib/apply-targets');
const { FILES, CONFIG_JSON, FANE_IMAGE_DIR } = require('./lib/vane');

// Vane's end-of-answer bookkeeping, as in the chat route's own tail.
const FINISH = 'a.emit("end",{});await i.A.update(j.messages).set({status:"completed",responseBlocks:a.getAllBlocks()}).where((0,k.Uo)((0,k.eq)(j.messages.chatId,b.chatId),(0,k.eq)(j.messages.messageId,b.messageId))).execute()';

// The previous answer of this chat, read from Vane's database: the browser's own history keeps the
// progress text of an answer until the page is reloaded, so it may lack images the answer finished with.
// (The text blocks of the newest earlier message; the current message is already saved, so it is skipped.)
const LAST_ANSWER = 'async()=>{let R=await i.A.select().from(j.messages).where((0,k.eq)(j.messages.chatId,b.chatId)),M=R.filter(r=>r.messageId!==b.messageId).sort((p,q)=>p.id-q.id).pop(),B=M&&(typeof M.responseBlocks==="string"?JSON.parse(M.responseBlocks):M.responseBlocks);return Array.isArray(B)?B.filter(x=>x.type==="text").map(x=>x.data).join(String.fromCharCode(10)):null}';

const HOOK = `if(await(async()=>{try{let H=await import(${JSON.stringify(`file://${FANE_IMAGE_DIR}/vane-hook.mjs`)});return await H.handleImageRequest(b.followUp,{lastAnswer:${LAST_ANSWER},history:b.chatHistory,mode:b.config.mode,configPath:${JSON.stringify(CONFIG_JSON)},emit:x=>{let B={id:crypto.randomUUID(),type:"text",data:x};a.emitBlock(B);return B.id},update:(I,x)=>{let B=a.getBlock(I);B&&(B.data=x,a.updateBlock(I,[{op:"replace",path:"/data",value:x}]))}})}catch(E){console.log("fane: image hook unavailable:",E&&E.message);return!1}})()){${FINISH};return}/*fane:image-chat*/`;

const CLASSIFY = 'let d=await (0,e.L)({chatHistory:b.chatHistory,enabledSources:b.config.sources,query:b.followUp,llm:b.config.llm}),l=h.u.executeAll(';

const TARGETS = [
  {
    name: 'image requests answered with images',
    file: FILES.chatRoute,
    from: CLASSIFY,
    to: HOOK + CLASSIFY,
    marker: '/*fane:image-chat*/', // hooks installed before `mode` was passed carry it too
  },
  {
    // Upgrade for a Vane that already has the older hook: hand over Vane's optimization mode.
    name: 'image hook receives the optimization mode',
    file: FILES.chatRoute,
    from: 'handleImageRequest(b.followUp,{configPath:',
    to: 'handleImageRequest(b.followUp,{mode:b.config.mode,configPath:',
    marker: 'mode:b.config.mode,configPath:', // later versions put `history` in front of it
  },
  {
    // Upgrade for a hook that has `mode` but not the chat history (needed for edits of earlier images).
    name: 'image hook receives the chat history',
    file: FILES.chatRoute,
    from: 'handleImageRequest(b.followUp,{mode:b.config.mode,configPath:',
    to: 'handleImageRequest(b.followUp,{history:b.chatHistory,mode:b.config.mode,configPath:',
    marker: 'history:b.chatHistory,mode:b.config.mode,configPath:', // later versions put `lastAnswer` in front of it
  },
  {
    // Upgrade for a hook that has the history but not lastAnswer (the history can be stale in the browser).
    name: 'image hook can read the previous answer',
    file: FILES.chatRoute,
    from: 'handleImageRequest(b.followUp,{history:b.chatHistory,mode:b.config.mode,configPath:',
    to: `handleImageRequest(b.followUp,{lastAnswer:${LAST_ANSWER},history:b.chatHistory,mode:b.config.mode,configPath:`,
  },
];

module.exports = { TARGETS, FINISH, LAST_ANSWER };
if (require.main === module) run('patch-image-chat', TARGETS);
