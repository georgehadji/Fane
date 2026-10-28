// Vane: icon-only buttons get a name and a size that can be hit.
// Measured on the pinned build: the question box's mode, sources, model, attach and send buttons, the chat header's
// share and delete, and each answer's rewrite, copy and read-aloud buttons were icons with no name, so a screen
// reader said "button" and a mouse user had no tooltip; most were 32px, the delete bin 17px and the follow-up's
// paperclip 24px (44px is the size for a finger).
//  - The three popover buttons of the question box (mode, sources, model) are named where Vane renders them.
//  - Every other icon-only button is named from its Lucide icon by a small script in the layout chunk, which every
//    page loads; it also marks each icon-only button `data-fane-icon` and gives it the icon's name as a tooltip.
//  - The stylesheet makes those buttons at least 32px, and 44px on touch screens.
// Browser chunks and the stylesheet are served with max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { APP_CSS_END: END, FILES } = require('./lib/vane');

// Injected as-is into the layout chunk (no imports, no closure). Lucide puts `lucide-<name>` on each icon's <svg>.
function LABEL_ICONS() {
  if (typeof window === 'undefined' || window.faneIconLabels) return;
  window.faneIconLabels = true;
  const NAMES = {
    share: 'Share', trash: 'Delete', 'trash-2': 'Delete', repeat: 'Rewrite', 'clipboard-list': 'Copy', copy: 'Copy',
    check: 'Copied', 'volume-2': 'Read aloud', volume2: 'Read aloud', 'volume-x': 'Stop reading', pause: 'Pause',
    paperclip: 'Attach files', 'arrow-up': 'Send', 'arrow-right': 'Send', settings: 'Settings', plus: 'New chat',
    x: 'Close', pencil: 'Edit', 'square-pen': 'Edit', 'pen-line': 'Edit', 'rotate-ccw': 'Retry',
  };
  const label = () => {
    for (const b of document.querySelectorAll('button,a[href]')) {
      if (b.hasAttribute('data-fane-icon') || b.textContent.trim() || !b.querySelector('svg')) continue;
      b.setAttribute('data-fane-icon', '');
      if (b.getAttribute('aria-label')) continue;
      const icons = (b.querySelector('svg').getAttribute('class') || '').match(/lucide-[a-z0-9-]+/g) || [];
      const name = icons.map((c) => NAMES[c.slice(7)]).find(Boolean);
      if (!name) continue;
      b.setAttribute('aria-label', name);
      if (!b.title) b.title = name;
    }
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; label(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  label();
}

const LAYOUT_END = '_N_E=e.O()}]);';
const MODE = '(h.ut,{type:"button",className:"p-2 text-black/50 dark:text-white/50 rounded-xl hover:bg-light-secondary';
const SOURCES = '(h.ut,{className:"flex items-center justify-center active:border-none hover:bg-light-200 hover:dark:bg-dark-200 p-2 rounded-lg focus:outline-none text-black/50';
const MODEL = '(h.ut,{type:"button",className:"active:border-none hover:bg-light-200  hover:dark:bg-dark-200 p-2 rounded-lg';
const named = (from, name) => from.replace('(h.ut,{', `(h.ut,{"aria-label":${JSON.stringify(name)},title:${JSON.stringify(name)},`);

// Buttons that were not flex boxes keep their icon centred when the minimum size makes them wider.
const SIZES = String.raw`/*fane:icon-buttons*/
button[data-fane-icon],a[data-fane-icon]{min-width:2rem;min-height:2rem}
button[data-fane-icon]:not(.flex):not(.hidden):not(.lg\:hidden){display:inline-flex;align-items:center;justify-content:center}
@media (pointer:coarse){button[data-fane-icon],a[data-fane-icon]{min-width:2.75rem;min-height:2.75rem}}`;

const TARGETS = [
  { name: 'icon buttons named from their icon', file: FILES.layoutClient, from: LAYOUT_END, to: `${LAYOUT_END};(${LABEL_ICONS})();` },
  { name: 'mode button named', file: FILES.messageClient, from: MODE, to: named(MODE, 'Answer mode') },
  { name: 'sources button named', file: FILES.messageClient, from: SOURCES, to: named(SOURCES, 'Sources') },
  { name: 'model button named', file: FILES.messageClient, from: MODEL, to: named(MODEL, 'Chat model') },
  { name: 'icon button sizes', file: FILES.appCss, from: END, to: `${END}\n${SIZES}\n`, marker: '/*fane:icon-buttons*/' },
];

module.exports = { TARGETS, LABEL_ICONS };
if (require.main === module) run('patch-icon-buttons', TARGETS);
