// patch-new-chat: Home ("/") clears a chat that is on screen, and must not clear the first message of a chat started
// at "/". The page moves the URL to /c/<id> with history.replaceState before it adds that message, and the injected
// effect reads the real address on every render. A render here is the injected effect run against fake state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planPatch, isApplied } = require('../../patches/lib/apply-targets.js');
const { TARGETS } = require('../../patches/patch-new-chat.js');

const [target] = TARGETS;
const F = target.file;
const FIXTURE = `function C(){${target.from}0}`; // the anchor ends with a comma, so a bare 0 closes the expression
const patched = planPatch({ [F]: FIXTURE }, TARGETS).next[F];
const inserted = target.to.slice(target.from.length);

// The effect body as the bundle has it: a comma expression of useEffect calls, run here as a render would.
const EFFECT = patched.slice(`function C(){`.length, -'0}'.length);
const RUN = new Function('s', 't', 'l', 'location', 'document', 'S', 'g', 'M', 'N', 'C', 'E', 'B', 'D', 'f', `${EFFECT} 0;`);

function render({ pathname, msgs, title = 'Old question - Vane' }) {
  const log = [];
  const rec = (name) => (v) => log.push([name, v]);
  const N = { current: ['old'] };
  const doc = { title };
  RUN({ useEffect: fn => fn() }, { chatId: undefined }, undefined, { pathname }, doc, msgs, rec('g'), rec('M'), N, rec('C'), rec('E'), rec('B'), rec('D'), rec('f'));
  return { log, title: doc.title, ref: N.current };
}

test('patch-new-chat: applies once to the chat client, and a second run applies nothing', () => {
  const one = planPatch({ [F]: FIXTURE }, TARGETS);
  assert.deepEqual(one.errors, []);
  assert.deepEqual(one.applied, [target.name]);
  assert.ok(isApplied(one.next[F], target));
  assert.deepEqual(planPatch(one.next, TARGETS).applied, []);
});

test('patch-new-chat: the reset is an effect with no dependency list, so it runs on every render', () => {
  assert.ok(inserted.includes('"/"===location.pathname&&S.length>0&&'), 'guard reads the address and the messages');
  assert.ok(inserted.endsWith('f(!1))}),'), 'no second argument: runs after every render');
});

test('patch-new-chat: Home with a chat on screen starts a new chat and sets the home title', () => {
  const home = render({ pathname: '/', msgs: [{ role: 'user', content: 'old' }] });
  assert.deepEqual(home.log.find(([n]) => n === 'g'), ['g', undefined]);
  assert.deepEqual(home.log.find(([n]) => n === 'M'), ['M', []]);
  assert.deepEqual(home.ref, []);
  assert.equal(home.title, 'Chat - Vane');
});

test('patch-new-chat: Home with nothing on screen does nothing', () => {
  assert.deepEqual(render({ pathname: '/', msgs: [] }).log, []);
});

test('patch-new-chat: the first message of a chat started at "/" survives, because the URL moves before it is added', () => {
  assert.deepEqual(render({ pathname: '/', msgs: [] }).log, []); // the user is on Home with an empty chat
  // the page: history.replaceState to /c/<id>, then the first message is added; the next render sees /c/<id>
  const sent = render({ pathname: '/c/abc', msgs: [{ role: 'user', content: 'first question' }] });
  assert.deepEqual(sent.log, []);
  assert.equal(sent.title, 'Old question - Vane'); // the tab title is not reset either
});

test('patch-new-chat: the guard reads the real address, so a message added while the address is still "/" is cleared', () => {
  // the order this test guards against: the message is added before replaceState, so the render still sees "/"
  const wrongOrder = render({ pathname: '/', msgs: [{ role: 'user', content: 'first question' }] });
  assert.ok(wrongOrder.log.some(([n, v]) => n === 'M' && Array.isArray(v) && v.length === 0), 'reset would wipe the first message');
});
