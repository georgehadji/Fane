// Facts about the pinned Vane build (docker-compose.yml digest) that several patches share.
const SERVER = '/home/vane/.next/server';

module.exports = {
  // Compiled bundles the patches edit.
  FILES: {
    research: `${SERVER}/chunks/641.js`, // research loop, search tools, SearXNG client, writer prompt
    llmParse: `${SERVER}/chunks/136.js`, // streamed tool-call argument parsing
    searchRoute: `${SERVER}/app/api/search/route.js`,
    chatRoute: `${SERVER}/app/api/chat/route.js`,
    uploadsRoute: `${SERVER}/app/api/uploads/route.js`,
    discoverRoute: `${SERVER}/app/api/discover/route.js`,
    discoverPage: `${SERVER}/app/discover/page.js`, // the Discover page, server-rendered
    homeNews: `${SERVER}/chunks/400.js`, // the home page's news card, server-rendered
    // Browser chunk with the Discover page; fixed by the pinned digest.
    discoverClient: '/home/vane/public/_next/static/chunks/app/discover/page-f0ca5ef8609da6a0.js',
    // Browser chunk with ChatProvider (the chat state: messages, chat id); fixed by the pinned digest.
    chatClient: '/home/vane/public/_next/static/chunks/1220-5cd2adbf287bf784.js',
    // Browser chunk with the message component (the answer and its side column); fixed by the pinned digest.
    messageClient: '/home/vane/public/_next/static/chunks/2415-6f80633347836171.js',
    // Browser chunk with the sidebar; the hash in the name is fixed by the pinned digest.
    layoutClient: '/home/vane/public/_next/static/chunks/app/layout-dae1640c324f0337.js',
    // Browser chunk with the Library page; fixed by the pinned digest.
    libraryClient: '/home/vane/public/_next/static/chunks/app/library/page-eb453b26ebb9698e.js',
    // Vane's compiled Tailwind stylesheet (served with max-age=0); fixed by the pinned digest.
    appCss: '/home/vane/public/_next/static/css/d3fb2aad7d23930e.css',
  },
  // The last rule of FILES.appCss (the xl: media block): patch-colors, patch-type and patch-editorial-greek append after it.
  APP_CSS_END: String.raw`.xl\:text-8xl{font-size:6rem;line-height:1}}`,
  // Title Vane's scraper returns instead of throwing when a page cannot be loaded.
  SCRAPE_FAILED_TITLE: 'Failed to scrape',
  // Source of an arrow function (ip, isIP) -> true for an address a scraped page must not reach. The same rule as
  // cli/image/download.mjs isPrivateAddress, which cannot be imported inside Vane's bundle; a test compares them on
  // a table of addresses. No backticks or ${ }: it is injected into a bundle.
  PRIVATE_ADDRESS: String.raw`(ip,isIP)=>{let h=/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(String(ip).toLowerCase()),v=h?[parseInt(h[1],16)>>8,parseInt(h[1],16)&255,parseInt(h[2],16)>>8,parseInt(h[2],16)&255].join("."):String(ip).toLowerCase().replace(/^::ffff:/,"");if(4===isIP(v)){let[a,b]=v.split(".").map(Number);return 0===a||10===a||127===a||169===a&&254===b||172===a&&b>=16&&b<=31||192===a&&168===b||100===a&&b>=64&&b<=127||a>=224}let f=parseInt(v.split(":")[0]||"0",16);return!(f>=8192&&f<=16383)||8194===f}`,
  // Vane's settings (providers and their API keys).
  CONFIG_JSON: '/home/vane/data/config.json',
  // Ends every answer of the image hook (cli/image/present.mjs ANSWER_MARKER; a test keeps them equal).
  IMAGE_ANSWER_MARKER: '<!--fane:image-answer-->',
  // Where generated images are stored: next to CONFIG_JSON, on the data volume. cli/image/store.mjs
  // derives the same path from the config path (a test keeps them equal).
  IMAGE_STORE_DIR: '/home/vane/data/fane-images',
  // Where Fane's image modules (cli/image) live in the container: docker-compose.yml mounts
  // them here and scripts/apply.mjs copies them here.
  FANE_IMAGE_DIR: '/fane/image',
  // Where Fane's shared modules (cli/core: language, formats, the request detectors) live in the container, mounted or
  // copied like FANE_IMAGE_DIR. The hooks of image, write, code and brainstorm import them as ../core.
  FANE_CORE_DIR: '/fane/core',
  // Where Fane's article modules (cli/write, with trial.json) live in the container, mounted or copied like FANE_IMAGE_DIR.
  FANE_WRITE_DIR: '/fane/write',
  // Where Fane's coding modules (cli/code, with trial.json) live in the container, mounted or copied like FANE_IMAGE_DIR.
  FANE_CODE_DIR: '/fane/code',
  // Ends every answer of the code hook (cli/code/present.mjs CODE_ANSWER_MARKER; a test keeps them equal).
  CODE_ANSWER_MARKER: '<!--fane:code-answer-->',
  // Where Fane's brainstorming modules (cli/brainstorm) live in the container, mounted or copied like FANE_IMAGE_DIR.
  // They read the article trial from FANE_WRITE_DIR (../write/trial.json).
  FANE_BRAINSTORM_DIR: '/fane/brainstorm',
  // The Fane project page (docs/ served by GitHub Pages), linked from Vane's menu by patch-fane-link.
  FANE_PAGE_URL: 'https://georgehadji.github.io/Fane/',
  // Files under here are served to the browser from disk (max-age=0): a reload picks a change up, no restart needed.
  BROWSER_DIR: '/home/vane/public/',
  // A patch whose targets are all browser files never needs Vane restarted (scripts/apply.mjs).
  needsRestart: (targets) => targets.some(t => !t.file.startsWith(module.exports.BROWSER_DIR)),
  // Google Fonts' greek subset range: patch-type's Commissioner face and patch-editorial-greek's face.
  GREEK_RANGE: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  // Text to put inside a JavaScript string or template literal of a bundle: non-ASCII as \u escapes.
  ascii: (s) => s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
};

// "el" when a text has more Greek letters than Latin ones, else undefined. Injected as-is into bundles
// (`(${LANG})(text)`: no imports, no closure) by patch-greek-lang and patch-sources-required. Its source text is in
// patched containers: changing it needs an upgrade target in patch-greek-lang.
module.exports.LANG = function LANG(text) {
  const s = typeof text === 'string' ? text : '';
  const greek = (s.match(/[Ͱ-Ͽἀ-῿]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  return greek > latin ? 'el' : undefined;
};

// Target shared by patch-scholarly-sources and patch-social-sources (whichever runs first
// applies it): rank search results on their original text, not on the metadata prefix those
// patches add. patch-web-search later rewrites this code and leaves the marker.
module.exports.RANK_ON_ORIGINAL_TEXT = {
  name: 'rank on original text',
  file: module.exports.FILES.research,
  from: 'let d=c.content||c.title,f=(await a.embedding.embedText([d]))[0];',
  to: 'let d=c.content||c.title,f=(await a.embedding.embedText([c.fane_text||d]))[0];',
  marker: '/*fane:rank-original*/',
};
