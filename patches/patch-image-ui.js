// Vane: no "Search images" / "Search videos" buttons under an answer that Fane made of images.
// Those buttons search the web for pictures and videos about the question; under generated
// images they are noise (and, with Vane's "auto image/video search" setting on, they would be
// clicked for you). Fane's hook ends every image answer with an invisible HTML comment
// (ANSWER_MARKER in cli/image/present.mjs); the message component here leaves the side column with
// the two buttons out when the answer text contains it. A browser chunk, served with
// max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { FILES, IMAGE_ANSWER_MARKER } = require('./lib/vane');

// In the message component: `h` is the answer text (parsedTextBlocks joined) and `b` says there is
// answer text. `b` also gates the answer itself and its action row, so only the side column's own
// use of it is changed.
const FROM = ',b&&(0,r.jsxs)("div",{className:"lg:sticky lg:top-20 flex flex-col items-center space-y-3';

const TARGETS = [
  {
    name: 'no image/video search buttons under generated images',
    file: FILES.messageClient,
    from: FROM,
    to: FROM.replace(',b&&', `,b&&!h.includes(${JSON.stringify(IMAGE_ANSWER_MARKER)})&&`),
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-image-ui', TARGETS);
