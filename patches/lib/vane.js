// Facts about the pinned Vane build (docker-compose.yml digest) that several patches share.
const SERVER = '/home/vane/.next/server';

module.exports = {
  // Compiled bundles the patches edit.
  FILES: {
    research: `${SERVER}/chunks/641.js`, // research loop, search tools, SearXNG client, writer prompt
    llmParse: `${SERVER}/chunks/136.js`, // streamed tool-call argument parsing
    searchRoute: `${SERVER}/app/api/search/route.js`,
    chatRoute: `${SERVER}/app/api/chat/route.js`,
  },
  // Title Vane's scraper returns instead of throwing when a page cannot be loaded.
  SCRAPE_FAILED_TITLE: 'Failed to scrape',
  // Vane's settings (providers and their API keys).
  CONFIG_JSON: '/home/vane/data/config.json',
  // Where Fane's image modules (cli/image) live in the container: docker-compose.yml mounts
  // them here and scripts/apply.mjs copies them here.
  FANE_IMAGE_DIR: '/fane/image',
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
