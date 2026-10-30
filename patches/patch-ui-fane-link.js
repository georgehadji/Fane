// Runs after patch-theme-toggle (file-name order) and inserts its icon in front of that patch's toggle: before the same anchor
// as the toggle itself it would split the toggle's own text, which the doctor checks as one piece.
// Vane: a "Fane" entry in the sidebar (desktop) and the bottom bar (phone), next to Home, Discover and
// Library. It opens the Fane project page (docs/) in a new tab. Browser chunk, so a normal reload picks it up.
const { run } = require('./lib/apply-targets');
const { FILES, FANE_PAGE_URL } = require('./lib/vane');

// In the sidebar module: s = react/jsx-runtime, i = Vane's `cn`, o = next/link. The lucide icons the
// nav items use take {size, className}; this one is the lucide "external link" shape, drawn the same way.
const ICON = 'fane_icon=({size:e=24,className:t})=>(0,s.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round",className:t,"aria-hidden":!0,children:[(0,s.jsx)("path",{d:"M15 3h6v6"}),(0,s.jsx)("path",{d:"M10 14 21 3"}),(0,s.jsx)("path",{d:"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"})]}),';
const THEME_TOGGLE = "fane_theme=()=>{let{resolvedTheme:e,setTheme:t}"; // added by patch-theme-toggle, which runs first
const LAST_ITEM = '{icon:d.A,href:"/library",active:t.includes("library"),label:"Library"}]';
const LINK = 'o(),{href:e.href,';
const OPEN_NEW_TAB = 'target:e.external?"_blank":void 0,rel:e.external?"noopener":void 0,';

const TARGETS = [
  { name: 'fane link icon', file: FILES.layoutClient, from: THEME_TOGGLE, to: ICON + THEME_TOGGLE, marker: 'fane_icon=(' },
  {
    name: 'fane link nav item',
    file: FILES.layoutClient,
    from: LAST_ITEM,
    to: LAST_ITEM.slice(0, -1) + `,{icon:fane_icon,href:${JSON.stringify(FANE_PAGE_URL)},active:!1,external:!0,label:"Fane"}]`,
  },
  {
    name: 'fane link opens in a new tab (sidebar)',
    file: FILES.layoutClient,
    from: LINK + 'className:(0,i.cn)("relative flex flex-col items-center justify-center',
    to: LINK + OPEN_NEW_TAB + 'className:(0,i.cn)("relative flex flex-col items-center justify-center',
  },
  {
    name: 'fane link opens in a new tab (phone bar)',
    file: FILES.layoutClient,
    from: LINK + 'className:(0,i.cn)("relative flex flex-col items-center space-y-1 text-center',
    to: LINK + OPEN_NEW_TAB + 'className:(0,i.cn)("relative flex flex-col items-center space-y-1 text-center',
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-ui-fane-link', TARGETS);
