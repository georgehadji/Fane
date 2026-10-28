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
    // Browser chunk with ChatProvider (the chat state: messages, chat id); fixed by the pinned digest.
    chatClient: '/home/vane/public/_next/static/chunks/1220-5cd2adbf287bf784.js',
    // Browser chunk with the message component (the answer and its side column); fixed by the pinned digest.
    messageClient: '/home/vane/public/_next/static/chunks/2415-6f80633347836171.js',
    // Browser chunk with the sidebar; the hash in the name is fixed by the pinned digest.
    layoutClient: '/home/vane/public/_next/static/chunks/app/layout-dae1640c324f0337.js',
  },
  // Title Vane's scraper returns instead of throwing when a page cannot be loaded.
  SCRAPE_FAILED_TITLE: 'Failed to scrape',
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
