// Vane: no weather card with made-up numbers, and no cut-off last line.
// The home page's weather card starts from zeros (0°C, humidity 0%, 0 m/s, no place) and keeps them when the weather
// call fails or no location arrives, so it showed "0°C · Humidity 0%" as if it were a reading. It is now left out
// until a reading with an icon arrives (its empty column is hidden, so the news card takes the row). The card was also
// fixed at 96px, which cut off "Humidity 64%" whenever the place name took two lines; it now grows from 96px.
// A browser chunk and the stylesheet, served with max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { APP_CSS_END: END, FILES } = require('./lib/vane');

// `a` is "loading", `e` the reading (`e.icon` stays "" until /api/weather answers).
const CARD = 'return(0,c.useEffect)(()=>{i();let e=setInterval(i,3e4);return()=>clearInterval(e)},[]),(0,r.jsx)("div",{className:"bg-light-secondary dark:bg-dark-secondary rounded-2xl border border-light-200 dark:border-dark-200 shadow-sm shadow-light-200/10 dark:shadow-black/25 flex flex-row items-center w-full h-24 min-h-[96px] max-h-[96px] px-3 py-2 gap-3",children:a?';

// The home page wraps the card in `<div class="flex-1 w-full">`; with no card it is empty.
const EMPTY = String.raw`/*fane:weather*/
.flex-1.w-full:empty{display:none}`;

const TARGETS = [
  {
    name: 'weather card only with a reading, and as tall as it needs',
    file: FILES.messageClient,
    from: CARD,
    to: CARD.replace('[]),(0,r.jsx)', '[]),!a&&!e.icon?null:(0,r.jsx)').replace(' h-24 min-h-[96px] max-h-[96px]', ' min-h-[96px]'),
  },
  { name: 'empty weather column hidden', file: FILES.appCss, from: END, to: `${END}\n${EMPTY}\n`, marker: '/*fane:weather*/' },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-weather', TARGETS);
