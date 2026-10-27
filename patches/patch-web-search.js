// Vane: web search fixes. Targets are in chunks/641.js. Runs after the quality, scholarly
// and social patches (file order); targets that depend on them have fallbacks or are optional.
//  2. Quality mode's extra search snippets (added by patch-quality-mode) skipped the
//     relevance check speed/balanced apply, so IP-localised junk (11 of 46 sources were
//     Greek sites for an English question) reached answers. -> score them against the
//     queries like speed does (cosine > 0.5, best first, max 8).
//  4. Speed and balanced never read a page; answers rest on ~160-char snippets.
//     -> balanced reads the top 3 results (max 2 chunks each) and appends extracted facts.
//  5. Every search result was embedded in its own call (up to ~25 per query).
//     -> one batched embedText call per query.
// (Fixes 1 and 3, language and engine cleanup, are in searxng/settings.yml.)
const { run } = require('./lib/apply-targets');
const { FILES, SCRAPE_FAILED_TITLE, RANK_ON_ORIGINAL_TEXT } = require('./lib/vane');

const PROMPT = 'Extract the facts from this scraped web page that help answer the queries. Use short bullet points, keep numbers, prices, dates and table values exactly as written, and ignore navigation, ads, cookie banners and other boilerplate. Reply as JSON {"extracted_facts": "- fact\\n- fact"}. If nothing on the page is relevant, return an empty string.';

// Relevance ranking for quality-mode snippets: C = candidates, V = embeddings of
// [...queries, ...candidates], n = number of queries. No backticks or ${ } allowed here.
const RANK = String.raw`(C,V,n)=>{let cos=(u,v)=>{let d=0,p=0,q=0;for(let k=0;k<u.length;k++){d+=u[k]*v[k];p+=u[k]*u[k];q+=v[k]*v[k]}return d/(Math.sqrt(p*q)||1)};return C.map((x,k)=>({x,s:Math.max(...V.slice(0,n).map(y=>cos(y,V[n+k])))})).filter(z=>z.s>.5).sort((u,v)=>v.s-u.s).slice(0,8).map(z=>z.x)}`;
// Text to embed: drop the "[authors | year ...]" / "[platform | date]" prefix other patches add.
const STRIP = String.raw`x=>String(x.content||"").replace(/^\[[^\]]*\] /,"")`;

const BATCHED = String.raw`try{let T=i.results.map(c=>c.content||c.title),[b,...F]=await a.embedding.embedText([h,...i.results.map((c,k)=>c.fane_text||T[k])]);j=i.results.map((c,k)=>({content:T[k],metadata:{title:c.title,url:c.url,similarity:(0,e.A)(b,F[k]),embedding:F[k]}})).filter(a=>a.metadata.similarity>.5)${RANK_ON_ORIGINAL_TEXT.marker}}`;

const BALANCED_READ = String.raw`let R=Array.from(i.keys()).map(a=>{let b=g[a];return delete b.metadata.embedding,delete b.metadata.similarity,b}).slice(0,20);if("balanced"===a.mode)await Promise.all(R.slice(0,3).map(async(x,k)=>{try{let P=await FANE_SCRAPE.A.scrape(x.metadata.url);if(!P||${JSON.stringify(SCRAPE_FAILED_TITLE)}===P.title)return;let O=await Promise.all((0,FANE_SPLIT.A)(P.content,4e3,500).slice(0,2).map(t=>a.llm.generateObject({schema:FANE_SCHEMA,messages:[{role:"system",content:FANE_PROMPT},{role:"user",content:"<queries>"+a.queries.join(", ")+"</queries>\n<scraped_data>"+t+"</scraped_data>"}]}).then(r=>r.extracted_facts,()=>"")));let D=O.filter(Boolean).join("\n");D&&(R[k]={...x,content:x.content+"\n"+D})}catch(err){console.log("fane: balanced page read failed",x.metadata.url,err)}}));return R}`;

// Vane's per-result embedding code around the line RANK_ON_ORIGINAL_TEXT edits.
const EMBED_HEAD = 'try{let b=(await a.embedding.embedText([h]))[0];j=(await Promise.all(i.results.map(async c=>{';
const EMBED_TAIL = 'return{content:d,metadata:{title:c.title,url:c.url,similarity:(0,e.A)(b,f),embedding:f}}}))).filter(a=>a.metadata.similarity>.5)}';

const TARGETS = [
  {
    // The speed/balanced block shadows g (scraper), h (splitter) and f (zod) with locals,
    // so capture them under new names at module level.
    name: 'module handles for page reading',
    from: 'c.d(b,{k:()=>i});var d=c(56471),e=c(25341),f=c(46901),g=c(96227),h=c(29092);',
    to: `c.d(b,{k:()=>i});var d=c(56471),e=c(25341),f=c(46901),g=c(96227),h=c(29092),FANE_SCRAPE=g,FANE_SPLIT=h,FANE_SCHEMA=f.Ay$.object({extracted_facts:f.Ay$.string()}),FANE_PROMPT=${JSON.stringify(PROMPT)};`,
  },
  {
    name: 'batched embeddings',
    // With or without RANK_ON_ORIGINAL_TEXT applied (scholarly/social patches).
    alts: [RANK_ON_ORIGINAL_TEXT.to, RANK_ON_ORIGINAL_TEXT.from].map(embedLine => ({ from: EMBED_HEAD + embedLine + EMBED_TAIL, to: BATCHED })),
  },
  {
    name: 'balanced reads top pages',
    from: 'return Array.from(i.keys()).map(a=>{let b=g[a];return delete b.metadata.embedding,delete b.metadata.similarity,b}).slice(0,20)}',
    to: BALANCED_READ,
  },
  {
    name: 'quality snippets ranked by relevance',
    optional: 'needs patch-quality-mode',
    from: '...i.filter(x=>!p.some(y=>y&&y.metadata.url===x.metadata.url)).sort((x,y)=>x.metadata.rank-y.metadata.rank).slice(0,8)]}',
    to: `...await(async()=>{let C=i.filter(x=>!p.some(y=>y&&y.metadata.url===x.metadata.url));try{let V=await a.embedding.embedText([...a.queries,...C.map(${STRIP})]);return(${RANK})(C,V,a.queries.length)}catch(err){return C.sort((x,y)=>x.metadata.rank-y.metadata.rank).slice(0,8)}})()]}`,
  },
].map(t => ({ file: FILES.research, ...t }));

module.exports = { TARGETS, RANK, STRIP };
if (require.main === module) run('patch-web-search', TARGETS);
