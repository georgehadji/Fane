// Vane: make the Social ("discussions") source return anything at all.
// Targets are in chunks/641.js. Runs after patch-scholarly-sources.js (file order) and
// builds on it when present; every target that depends on it has a fallback.
//  1. social_search only searched the "reddit" engine, which SearXNG ships disabled and
//     Reddit blocks (JSON API 403, "access denied"): every Social-only answer had 0 sources.
//     -> search Hacker News, Lemmy posts/comments, Stack Overflow, Super User, Ask Ubuntu.
//  2. Reddit itself through web engines: each query also runs as "site:reddit.com ..."
//     on the Brave Search API, Tavily and Yandex (REDDIT_ENGINES; Bing ignores site: and is
//     left out), and only reddit.com results are kept.
//  3. The tool also needed the classifier's discussionSearch flag. -> the Social toggle
//     alone enables it.
//  4. Tool description taught sentence queries; forum engines return 0 for those.
//     -> ask for 2-6 key terms.
//  5. Platform and date were dropped. -> prefix "[Hacker News | 2025-03-14]"; ranking
//     keeps using the original text.
//  6. Writer: community posts are opinions; report consensus, disagreement and dates.
const { run } = require('./lib/apply-targets');
const { FILES, RANK_ON_ORIGINAL_TEXT } = require('./lib/vane');

// Injected code below must contain no backticks; ${...} is only used to splice these constants.
// A reddit.com URL (any subdomain), as a JS regex literal.
const REDDIT_URL = String.raw`/^https?:\/\/(?:[\w-]+\.)*reddit\.com(?:[\/?#]|$)/`;

// Platform/date prefix for forum and Reddit results.
const SOCIAL = String.raw`r=>{let N={hackernews:"Hacker News","lemmy posts":"Lemmy","lemmy comments":"Lemmy comment",stackoverflow:"Stack Overflow",superuser:"Super User",askubuntu:"Ask Ubuntu"}[String(r.engine||"")]||(${REDDIT_URL}.test(String(r.url||""))?"Reddit":"");if(!N)return r;let D=r.publishedDate?String(r.publishedDate).slice(0,10):"";return{...r,fane_text:r.fane_text||r.content||r.title,content:"["+[N,D].filter(Boolean).join(" | ")+"] "+(r.content||r.title)}}`;

// Engines for the site:reddit.com searches. The two keyed ones (searxng/settings.yml) are not loaded without their
// key, and SearXNG then drops their names, so Yandex alone is left. Google, DuckDuckGo, Brave and Startpage, named
// by the first version, are blocked from this network and only added waiting time.
const REDDIT_ENGINES = ['brave api', 'tavily', 'yandex'];
const search = (engines) => String.raw`return{type:"search_results",results:await(async()=>{let o={llm:b.llm,embedding:b.embedding,mode:b.mode,researchBlock:c,session:b.session},[F,R]=await Promise.all([(0,e.k)({...o,queries:a.queries,searchConfig:{engines:["hackernews","lemmy posts","lemmy comments","stackoverflow","superuser","askubuntu"]}}),(0,e.k)({...o,queries:a.queries.map(x=>"site:reddit.com "+x),searchConfig:{engines:${JSON.stringify(engines)}}})]);return[...F,...R.filter(x=>${REDDIT_URL}.test(String(x.metadata&&x.metadata.url)))]})()}`;
const SEARCH = search(REDDIT_ENGINES);
const SEARCH_V1 = search(['yandex', 'google', 'duckduckgo', 'brave', 'startpage']);

// A target may list alternative from/to pairs (with and without the scholarly patch).
const TARGETS = [
  {
    name: 'social toggle enables the tool',
    from: 'enabled:a=>a.sources.includes("discussions")&&!1===a.classification.classification.skipSearch&&!0===a.classification.classification.discussionSearch',
    to: 'enabled:a=>a.sources.includes("discussions")&&!1===a.classification.classification.skipSearch/*fane:social-toggle*/',
  },
  {
    name: 'forum engines + Reddit via site search',
    alts: [
      { from: 'return{type:"search_results",results:await (0,e.k)({llm:b.llm,embedding:b.embedding,mode:b.mode,queries:a.queries,researchBlock:c,session:b.session,searchConfig:{engines:["reddit"]}})}', to: SEARCH },
      { from: SEARCH_V1, to: SEARCH }, // a container patched with the first engine list
    ],
  },
  {
    name: 'keyword-style social queries',
    from: 'You can provide up to 3 queries at a time. Make sure the queries are specific and relevant to the user\'s needs.\n\nFor example, if the user is interested in public opinion on electric vehicles, your queries could be:\n1. "Electric vehicles public opinion 2024"\n2. "Social media discussions on EV adoption"\n3. "Trends in electric vehicle usage"',
    to: 'You can provide up to 3 queries at a time. Forum search engines (Hacker News, Lemmy, Stack Exchange, Reddit) match keywords and return nothing for long sentences: write each query as 2-6 key terms, with no filler words, no years and no question phrasing. Do not add words like "reddit", "opinion" or "discussion"; the tool already searches discussion sites.\n\nFor example, if the user is interested in public opinion on electric vehicles, your queries could be:\n1. "electric car ownership"\n2. "EV charging problems"\n3. "EV battery degradation"',
  },
  {
    name: 'platform and date in results',
    alts: [
      { from: 'c=(b.results||[]).map(r=>{let A=', to: `c=(b.results||[]).map(${SOCIAL}).map(r=>{let A=` },
      { from: 'let b=await a.json(),c=b.results,d=b.suggestions;', to: `let b=await a.json(),c=(b.results||[]).map(${SOCIAL}),d=b.suggestions;` },
    ],
  },
  RANK_ON_ORIGINAL_TEXT, // shared with patch-scholarly-sources; a no-op when that ran first
  {
    name: 'writer treats posts as opinions',
    from: '\n\n    ### Citation Requirements',
    to: '\n\n    ### Community sources\n    - Some sources start with a bracket such as [Reddit], [Hacker News | 2025-03-14] or [Stack Overflow]. These are posts by individuals: opinions, anecdotes and advice, not established facts.\n    - Report what most posters agree on and where they disagree, attribute claims ("several Hacker News commenters report ..."), and give dates when opinions may be outdated.\n    - Never present a single post as fact, and say so when the discussion sources are few or one-sided.\n\n    ### Citation Requirements',
  },
].map(t => ({ file: FILES.research, ...t }));

module.exports = { TARGETS, SOCIAL, REDDIT_URL };
if (require.main === module) run('patch-social-sources', TARGETS);
