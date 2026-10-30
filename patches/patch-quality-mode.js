// Vane: make "quality" (Beta) mode return more sources, stay bounded, and stop padding.
// All targets are in the research/writer chunk. Upstream behaviour being fixed:
//  1. Each quality web_search scrapes <=3 picked results and drops every other
//     search snippet, so quality ends up with fewer sources than speed.
//     -> also return the top 8 unpicked snippets, ranked by their per-query position.
//  2. Writer must produce >=2000 words whatever the question.
//     -> length matches the question.
//  3. A page that fails to scrape (bot walls) or yields no facts vanishes.
//     -> fall back to its search snippet.
//  4. Every 4000-char chunk of every scraped page is a parallel LLM call (unbounded),
//     and facts are concatenated in completion order.
//     -> max 4 chunks per page, facts kept in page order, pages kept in pick order.
//  5. Quality loop allows 25 iterations while the prompt says "up to 10 tools", and
//     re-sends full tool results every iteration.
//     -> 10 iterations; the researcher sees results trimmed to 1500 chars each
//        (the writer still gets the full findings).
//  6. The researcher prompt says "Do not call done early—exhaust your research budget first"
//     and also "Aim for 4-7 information-gathering calls", so models were told to run every
//     iteration, each reading up to 3 pages at 4 chunks.
//     -> the budget line now agrees with 4-7 calls.
//  7. Nothing stops a loop whose searches keep returning pages it already has.
//     -> two rounds in a row with no new page (URL) end the research.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// Runs at the end of each research round, where `r` is the round's tool results and `b` the research input.
const STOP = String.raw`;if("quality"===b.config.mode){let N=0;r.forEach(x=>{x&&"search_results"===x.type&&(x.results||[]).forEach(y=>{let u=y.metadata?.url;u&&!faneSeen.has(u)&&(faneSeen.add(u),N++)})});faneStale=faneSeen.size&&!N?faneStale+1:0;if(faneStale>=2){console.log("fane: quality research stopped after round "+(g+1)+", two rounds found no new page");break}}`;
const LOOP_END = '}let l=c.filter(a=>"search_results"===a.type).flatMap(a=>a.results),m=new Map,n=l.map(';

const TARGETS = [
  {
    name: 'rank snippets',
    from: 'h=g.results.map(a=>({content:a.content||a.title,metadata:{title:a.title,url:a.url,similarity:1,embedding:[]}}))',
    to: 'h=g.results.map((a,R)=>({content:a.content||a.title,metadata:{title:a.title,url:a.url,similarity:1,embedding:[],rank:R}}))',
  },
  {
    name: 'keep pick order',
    from: 'return await Promise.all(o.map(async(b,c)=>{try{let c=await g.A.scrape(',
    to: 'return await Promise.all(o.map(async(b,P)=>{try{let c=await g.A.scrape(',
  },
  {
    name: 'scrape fallback + chunk cap',
    from: 'if(!c)return;let d="",e=(0,h.A)(c.content,4e3,500);await Promise.all(e.map(async b=>{try{let c=await a.llm.generateObject({schema:r,',
    to: 'if(!c){p[P]=b;return}let d="",F=[],e=(0,h.A)(c.content,4e3,500).slice(0,4);await Promise.all(e.map(async(b,x)=>{try{let c=await a.llm.generateObject({schema:r,',
    // patch-scholarly-sources edits the start of `to`; this part stays as written
    marker: 'F=[],e=(0,h.A)(c.content,4e3,500).slice(0,4)',
  },
  {
    name: 'ordered facts + snippets in result',
    from: 'd+=c.extracted_facts+"\\n"}catch(a){console.log("Error extracting information from chunk",a)}})),p.push({...b,content:d})}catch(a){console.log("Error scraping or extracting information from",b.metadata.url,a)}})),p}',
    to: 'F[x]=c.extracted_facts}catch(a){console.log("Error extracting information from chunk",a)}})),d=F.filter(Boolean).join("\\n"),p[P]={...b,content:d||b.content}}catch(a){console.log("Error scraping or extracting information from",b.metadata.url,a),p[P]=b}})),[...p.filter(Boolean),...i.filter(x=>!p.some(y=>y&&y.metadata.url===x.metadata.url)).sort((x,y)=>x.metadata.rank-y.metadata.rank).slice(0,8)]}',
    // patch-web-search replaces the snippet ranking at the end of `to`
    marker: 'd=F.filter(Boolean).join(',
  },
  {
    name: 'writer length',
    from: "ASSISTANT'S RESPONSES SHALL NOT BE LESS THAN AT LEAST 2000 WORDS, COVER EVERYTHING AND FRAME IT LIKE A RESEARCH REPORT.",
    to: 'MATCH THE LENGTH TO THE QUESTION: A NARROW QUESTION GETS A FOCUSED ANSWER OF A FEW HUNDRED WORDS, A BROAD OR MULTI-PART TOPIC CAN RUN TO 2000+ WORDS. NEVER PAD OR REPEAT; EVERY PARAGRAPH MUST ADD INFORMATION FROM THE CONTEXT. FRAME BROAD TOPICS LIKE A RESEARCH REPORT.',
  },
  {
    name: 'iteration budget',
    from: '"balanced"===b.config.mode?6:25',
    to: '"balanced"===b.config.mode?6:10',
  },
  {
    name: 'compact researcher context',
    from: 'r.forEach((a,b)=>{k.push({role:"tool",id:q[b].id,name:q[b].name,content:JSON.stringify(a)})})',
    to: 'r.forEach((a,B)=>{k.push({role:"tool",id:q[B].id,name:q[B].name,content:JSON.stringify("quality"===b.config.mode&&a&&"search_results"===a.type?{...a,results:a.results.map(x=>({title:x.metadata?.title,url:x.metadata?.url,content:String(x.content||"").slice(0,1500)}))}:a)})})',
  },
  {
    name: 'budget line agrees with 4-7 calls',
    from: 'Do not call done early—exhaust your research budget first.',
    to: 'Most questions are covered in 4-7 information-gathering calls; call done once more searches would only repeat what you already have.',
  },
  {
    name: 'pages seen across rounds',
    from: 'for(let g=0;g<d;g++){let l=(0,f.b)(i,b.config.mode,g,d,b.config.fileIds)',
    to: 'let faneSeen=new Set,faneStale=0;for(let g=0;g<d;g++){let l=(0,f.b)(i,b.config.mode,g,d,b.config.fileIds)',
    marker: 'let faneSeen=new Set',
  },
  { name: 'stop after two rounds without a new page', from: LOOP_END, to: STOP + LOOP_END, marker: 'if(faneStale>=2)' },
].map(t => ({ file: FILES.research, ...t }));

module.exports = { TARGETS, STOP };
if (require.main === module) run('patch-quality-mode', TARGETS);
