// Vane: one-click light/dark toggle in the sidebar, above the settings button. Vane already has
// both themes (next-themes, class attribute, default dark), but switching meant Settings ->
// Preferences -> Theme. The button calls next-themes' own setTheme, so the choice is stored
// under the same localStorage key the settings page reads. In the desktop sidebar, and on phones next to the home
// page's gear (below).
// The same sidebar's settings gear is a plain <div> with an onClick: no role, no tab stop, no name, so a
// keyboard or screen-reader user could not open Settings. It becomes a labelled button (Enter/Space).
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

// The gear: `t(!0)` opens the settings dialog.
const GEAR = 'onClick:()=>t(!0),children:(0,s.jsx)(p.A,{size:19,className:"cursor-pointer"})})';
const GEAR_KEYS = 'role:"button",tabIndex:0,"aria-label":"Settings",onKeyDown:k=>{("Enter"===k.key||" "===k.key)&&(k.preventDefault(),t(!0))},';

// The toggle and the gear in one column. Only classes in Vane's compiled stylesheet work (Tailwind kept only the
// ones Vane uses): the first version's gap-y-3 is not there, so the two circles touched; gap-y-4 is 16px.
const stacked = (gap) => SETTINGS.replace('(0,s.jsx)(u,{})', `(0,s.jsxs)("div",{className:"flex flex-col items-center ${gap}",children:[(0,s.jsx)(fane_theme,{}),(0,s.jsx)(u,{})]})`);

const TARGETS = [
  {
    name: 'theme toggle component',
    file: FILES.layoutClient,
    from: NEXT_TO,
    to: TOGGLE + NEXT_TO,
    marker: 'fane_theme=()=>',
  },
  {
    name: 'theme toggle above settings',
    file: FILES.layoutClient,
    alts: [{ from: SETTINGS, to: stacked('gap-y-4') }, { from: stacked('gap-y-3'), to: stacked('gap-y-4') }],
  },
];

TARGETS.push({
  name: 'settings gear is a labelled button',
  file: FILES.layoutClient,
  from: GEAR,
  to: GEAR_KEYS + GEAR,
  marker: '"aria-label":"Settings",onKeyDown',
});

// Phones: the home page's gear (lg:hidden, top right, an 18px button with no name) gets the same toggle beside it, and
// both become 44px labelled buttons. In the message chunk: r = react/jsx-runtime, c = react, eN = next-themes.
const PHONE_GEAR = 'e1=()=>{let[e,t]=(0,c.useState)(!1);return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)("button",{className:"lg:hidden",onClick:()=>t(!0),children:(0,r.jsx)(eZ.A,{size:18})})';
const R = (code) => code.replace(/\(0,s\.jsx\)/g, '(0,r.jsx)');
const TAP = 'className:"flex items-center justify-center",style:{width:44,height:44}';
TARGETS.push({
  name: 'theme toggle and labelled settings on phones',
  file: FILES.messageClient,
  from: PHONE_GEAR,
  to: 'e1=()=>{let[e,t]=(0,c.useState)(!1),{resolvedTheme:fane_rt,setTheme:fane_st}=(0,eN.D)(),[fane_m,fane_sm]=(0,c.useState)(!1);(0,c.useEffect)(()=>fane_sm(!0),[]);'
    + 'let fane_l=fane_m&&"light"===fane_rt,fane_tl=fane_l?"Switch to dark theme":"Switch to light theme";'
    + 'return(0,r.jsxs)(r.Fragment,{children:[(0,r.jsxs)("div",{className:"lg:hidden flex flex-row items-center",children:['
    + `(0,r.jsx)("button",{type:"button","aria-label":fane_tl,title:fane_tl,${TAP},onClick:()=>{fane_st(fane_l?"dark":"light"),window.dispatchEvent(new Event("client-config-changed"))},`
    + `children:(0,r.jsxs)("svg",{width:18,height:18,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":!0,children:fane_l?${R(MOON)}:${R(SUN)}})}),`
    + `(0,r.jsx)("button",{type:"button","aria-label":"Settings",title:"Settings",${TAP},onClick:()=>t(!0),children:(0,r.jsx)(eZ.A,{size:18})})]})`,
});

module.exports = { TARGETS };
if (require.main === module) run('patch-theme-toggle', TARGETS);
