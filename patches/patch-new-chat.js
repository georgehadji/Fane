// Vane: the Home button (and the "+" new-chat button) keep showing the previous chat.
// Vane's chat state (ChatProvider, a browser chunk) resets only when the URL carries a *different
// chat id*. Home goes to "/", which has none, so the old chat's messages stay on screen under the
// new URL and there is no question box. This adds the missing reset: when the address is "/" while
// messages are on screen, the chat state is cleared and a new chat starts, exactly as if the page had
// been opened at "/". The check runs on every render and reads the real address: a chat started at
// "/" is moved to /c/<id> by history.replaceState before its first message is added, and Vane's route
// params do not follow that, nor does its import of next/navigation have usePathname. The tab title,
// which Vane sets to the old chat's question, goes back to the home page's. Served with max-age=0:
// a normal reload picks it up.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// In ChatProvider: t = route params, l = chat id state, S = messages; g/M/N/C/E/B/D/f are the resets
// Vane's own "chat id changed" effect performs (g sets the chat id: undefined makes Vane start a new one).
const CHAT_ID_EFFECT = '(0,s.useEffect)(()=>{t.chatId&&t.chatId!==l&&(g(t.chatId),M([]),N.current=[],C([]),E([]),B(!1),D(!1),f(!1))},[t.chatId,l]),';

const TARGETS = [
  {
    name: 'Home starts a new chat',
    file: FILES.chatClient,
    from: CHAT_ID_EFFECT,
    to: CHAT_ID_EFFECT + '(0,s.useEffect)(()=>{"/"===location.pathname&&S.length>0&&(document.title="Chat - Vane",g(void 0),M([]),N.current=[],C([]),E([]),B(!1),D(!1),f(!1))}),',
    marker: '"/"===location.pathname&&',
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-new-chat', TARGETS);
