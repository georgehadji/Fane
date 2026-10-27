// Vane: one-click light/dark toggle in the sidebar, above the settings button. Vane already has
// both themes (next-themes, class attribute, default dark), but switching meant Settings ->
// Preferences -> Theme. The button calls next-themes' own setTheme, so the choice is stored
// under the same localStorage key the settings page reads. Desktop sidebar only; the mobile
// bottom bar has no settings button either.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// In the sidebar module: s = react/jsx-runtime, m = react, a = webpack require.
// Module 70460 is next-themes (D = useTheme). `n` waits for mount: the theme is unknown on the server.
const ICON = 'p-2.5 rounded-full bg-light-200 text-black/70 dark:bg-dark-200 dark:text-white/70 hover:opacity-70 hover:scale-105 transition duration-200 cursor-pointer active:scale-95';
const SUN = '[(0,s.jsx)("circle",{cx:12,cy:12,r:4}),(0,s.jsx)("path",{d:"M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"})]';
const MOON = '[(0,s.jsx)("path",{d:"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"})]';
const TOGGLE = `fane_theme=()=>{let{resolvedTheme:e,setTheme:t}=(0,a(70460).D)(),[n,r]=(0,m.useState)(!1);(0,m.useEffect)(()=>r(!0),[]);let l=n&&"light"===e,c=l?"Switch to dark theme":"Switch to light theme";return(0,s.jsx)("button",{type:"button","aria-label":c,title:c,className:${JSON.stringify(ICON)},onClick:()=>{t(l?"dark":"light"),window.dispatchEvent(new Event("client-config-changed"))},children:(0,s.jsxs)("svg",{width:19,height:19,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":!0,children:l?${MOON}:${SUN}})})},`;

const NEXT_TO = 'y=({children:e})=>(0,s.jsx)("div",{className:"flex flex-col items-center w-full",children:e}),v=';
const SETTINGS = '(0,s.jsx)(u,{})]})}),(0,s.jsx)("div",{className:"fixed bottom-0';

const TARGETS = [
  {
    name: 'theme toggle component',
    file: FILES.layoutClient,
    from: NEXT_TO,
    to: TOGGLE + NEXT_TO,
  },
  {
    name: 'theme toggle above settings',
    file: FILES.layoutClient,
    from: SETTINGS,
    to: SETTINGS.replace('(0,s.jsx)(u,{})', '(0,s.jsxs)("div",{className:"flex flex-col items-center gap-y-3",children:[(0,s.jsx)(fane_theme,{}),(0,s.jsx)(u,{})]})'),
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-theme-toggle', TARGETS);
