// Vane: make the Academic source dependable and its results citable.
// Runs after patch-quality-mode.js (file order); targets are in chunks/641.js.
//  1. academic_search only ran when the classifier ALSO flagged the question as a
//     paper request, so with Academic on and Web off "Is coffee bad for your heart?"
//     got 0 sources. -> the Academic toggle alone enables the tool.
//  2. Tool description taught sentence-style queries ("Recent advancements in X 2024");
//     arXiv, PubMed and Semantic Scholar return 0 results for those.
//     -> ask for 2-6 key terms per query.
//  3. Engines were arxiv, google scholar, pubmed, and only Scholar handled long
//     queries. -> add openalex, crossref, semantic scholar (enabled in searxng/settings.yml).
//  4. SearXNG returns authors/date/venue/DOI for papers; Vane dropped them.
//     -> prefix paper results with "[authors | year | venue | doi | preprint (arXiv)]".
//        Embedding similarity still uses the original text, so the prefix does not
//        change which results pass the relevance filter.
//  5. Writer: cite papers by first author + year and flag preprints.
//  6. Paywalled publisher URLs (ScienceDirect, Springer, Wiley, IEEE, T&F, ACS) are
//     swapped for the paper's arXiv abstract page when the result links one, since
//     the scraper renders HTML only.
//  Also (optional, needs patch-quality-mode): a failed scrape returns
//  {title:"Failed to scrape"} rather than nothing, so quality mode now treats it as a
//  failure and keeps the search snippet instead of extracting from an error page.
const fs = require('fs');
const vm = require('vm');

const FILE = '/home/vane/.next/server/chunks/641.js';

// Paper enrichment, inserted into the SearXNG client. No backticks or ${ } allowed here.
const ENRICH = String.raw`r=>{let A=Array.isArray(r.authors)?r.authors.map(x=>String(x).trim()).filter(Boolean):[];if(!A.length&&!r.doi&&!r.journal)return r;let U=String(r.url||""),X=(String(r.pdf_url||"")+" "+String(r.html_url||"")).match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/),M=[A.slice(0,3).join(", ")+(A.length>3?" et al.":""),r.publishedDate?String(r.publishedDate).slice(0,4):"",r.journal||r.publisher||"",r.doi?"doi:"+r.doi:"",/arxiv\.org/.test(U)||X&&!r.journal?"preprint (arXiv)":""].filter(Boolean).join(" | ");/sciencedirect\.com|link\.springer\.com|onlinelibrary\.wiley\.com|ieeexplore\.ieee\.org|tandfonline\.com|pubs\.acs\.org/.test(U)&&X&&(U="https://arxiv.org/abs/"+X[1]);return{...r,url:U,fane_text:r.content||r.title,content:"["+M+"] "+(r.content||r.title)}}`;

const TARGETS = [
  {
    name: 'academic toggle enables the tool',
    from: 'enabled:a=>a.sources.includes("academic")&&!1===a.classification.classification.skipSearch&&!0===a.classification.classification.academicSearch',
    to: 'enabled:a=>a.sources.includes("academic")&&!1===a.classification.classification.skipSearch/*fane:academic-toggle*/',
  },
  {
    name: 'keyword-style academic queries',
    from: 'You can provide up to 3 queries at a time. Make sure the queries are specific and relevant to the user\'s needs.\n\nFor example, if the user is interested in recent advancements in renewable energy, your queries could be:\n1. "Recent advancements in renewable energy 2024"\n2. "Cutting-edge research on solar power technologies"\n3. "Innovations in wind energy systems"',
    to: 'You can provide up to 3 queries at a time. Scholarly search engines (arXiv, PubMed, Semantic Scholar) match keywords and return nothing for long sentences: write each query as 2-6 key terms, with no filler words, no years and no question phrasing. Use the queries for different angles (method names, synonyms, the specific problem).\n\nFor example, if the user is interested in recent advancements in renewable energy, your queries could be:\n1. "perovskite solar cell efficiency"\n2. "offshore wind turbine wake modeling"\n3. "grid-scale battery storage"',
  },
  {
    name: 'academic engines',
    from: 'searchConfig:{engines:["arxiv","google scholar","pubmed"]}',
    to: 'searchConfig:{engines:["arxiv","google scholar","pubmed","openalex","crossref","semantic scholar"]}',
  },
  {
    name: 'paper metadata in results',
    from: 'let b=await a.json(),c=b.results,d=b.suggestions;return{results:c,suggestions:d}',
    to: `let b=await a.json(),c=(b.results||[]).map(${ENRICH}),d=b.suggestions;return{results:c,suggestions:d}`,
    // patch-social-sources inserts another .map() here
    marker: 'fane_text:r.content||r.title,content:"["+M+"] "',
  },
  {
    name: 'rank on original text',
    from: 'let d=c.content||c.title,f=(await a.embedding.embedText([d]))[0];',
    to: 'let d=c.content||c.title,f=(await a.embedding.embedText([c.fane_text||d]))[0];',
    // patch-web-search rewrites this into one batched call and leaves this comment
    marker: '/*fane:rank-original*/',
  },
  {
    name: 'writer cites papers by author and year',
    from: 'where appropriate.\n\n    ### Citation Requirements',
    to: 'where appropriate.\n\n    ### Scholarly sources\n    - Some sources start with a bracket such as [authors | year | venue | doi | preprint (arXiv)]. When you use one, name the first author and year in the sentence (for example "Chen et al. (2025) show ...") as well as giving the [number] citation.\n    - Say when a finding rests only on preprints (arXiv) that have not been peer reviewed.\n    - When papers disagree, say so, and give more weight to peer-reviewed and more recent work.\n\n    ### Citation Requirements',
    // patch-social-sources inserts its section before "### Citation Requirements"
    marker: '### Scholarly sources',
  },
  {
    name: 'quality: failed scrape keeps the snippet',
    optional: 'needs patch-quality-mode',
    from: 'if(!c){p[P]=b;return}',
    to: 'if(!c||"Failed to scrape"===c.title){p[P]=b;return}',
  },
];

const original = fs.readFileSync(FILE, 'utf8');
let s = original;
let applied = 0;
// Check every target first so a mismatch leaves the file untouched.
// `marker` (when set) detects "already applied" for targets a later patch edits further.
for (const t of TARGETS) {
  if (s.includes(t.to) || (t.marker && s.includes(t.marker))) continue;
  const count = s.split(t.from).length - 1;
  if (count === 0 && t.optional) {
    console.log(`${t.name}: skipped (${t.optional})`);
    continue;
  }
  if (count !== 1) {
    console.error(`${t.name}: expected 1 match, found ${count}; not patching anything`);
    process.exit(1);
  }
  s = s.replace(t.from, () => t.to);
  applied++;
}
if (!applied) {
  console.log('already patched');
  process.exit(0);
}
// Never write a bundle that does not parse.
try {
  new vm.Script(s, { filename: FILE });
} catch (err) {
  console.error(`patched bundle does not parse (${err.message}); not patching anything`);
  process.exit(1);
}
if (!fs.existsSync(`${FILE}.bak`)) fs.writeFileSync(`${FILE}.bak`, original);
fs.writeFileSync(FILE, s);
console.log(`patched ${applied} of ${TARGETS.length} targets (backup: ${FILE}.bak)`);
