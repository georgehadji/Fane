// Vane: serve the images Fane generates (cli/image/store.mjs writes them next to config.json).
// Vane has no route that serves such files, and files added to public/ after it started are
// not served until a restart, so the images are served by Vane's own /api/uploads route, which
// only had a POST: this adds a GET that hands the request to Fane's serveImage(). That GET
// serves only names Fane's store wrote (a content hash plus a known extension); anything else,
// or a missing Fane module, is a 404.
const { run } = require('./lib/apply-targets');
const { FILES, FANE_IMAGE_DIR, IMAGE_STORE_DIR } = require('./lib/vane');

const FROM = 'c.d(b,{POST:()=>i});var e=c(23211),f=c(16505),g=c(22311),h=a([g]);async function i(a){';
const SERVE = `async function fane_img(a){try{let H=await import(${JSON.stringify(`file://${FANE_IMAGE_DIR}/store.mjs`)});return await H.serveImage(a,{dir:${JSON.stringify(IMAGE_STORE_DIR)}})}catch(E){return new Response("Not found",{status:404})}}`;

const TARGETS = [
  {
    name: 'uploads route serves Fane images',
    file: FILES.uploadsRoute,
    from: FROM,
    to: FROM.replace('{POST:()=>i}', '{GET:()=>fane_img,POST:()=>i}').replace('async function i(a){', `${SERVE}async function i(a){`),
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-image-serve', TARGETS);
