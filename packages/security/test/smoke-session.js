import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client/session.js', import.meta.url), 'utf8');
function browser({ entry = true, demo = false } = {}) {
  let now = 1_000_000;
  const storage = new Map([['session', JSON.stringify({ token: 'session-token', demo })], ['ctl', JSON.stringify({ token: 'control-token' })], ['cfg', JSON.stringify({ user: 'mqtt-user', pass: 'mqtt-password' })]]);
  const tab = new Map(entry ? [['app-entry', 'session-token']] : []);
  const listeners = new Map();
  const intervals = [];
  const timeouts = new Map();
  const calls = [];
  const redirects = [];
  const store = (data) => ({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) });
  const listen = (target, event, callback) => {
    const key = `${target}:${event}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(callback);
  };
  const fire = (target, event, data = {}) => { for (const callback of listeners.get(`${target}:${event}`) || []) callback(data); };
  const document = {
    hidden: false, documentElement: { style: {} },
    addEventListener: (event, callback) => listen('document', event, callback),
    dispatchEvent: (event) => fire('document', event.type),
  };
  const window = {
    async fetch(url, options) { calls.push({ url, options }); return new Response('{}'); },
    addEventListener: (event, callback) => listen('window', event, callback),
  };
  vm.runInNewContext(source, {
    window, document, URL, Response, Event,
    location: { origin: 'https://app.test', href: 'https://app.test/index.html', pathname: '/index.html', replace: (url) => redirects.push(url) },
    localStorage: store(storage), sessionStorage: store(tab), Date: { now: () => now },
    setInterval: (callback) => intervals.push(callback),
    setTimeout: (callback, delay) => { const id = timeouts.size + 1; timeouts.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
  });
  return {
    window, document, storage, tab, calls, redirects, fire,
    advance(ms) {
      now += ms;
      for (const callback of intervals) callback();
      for (const [id, timer] of [...timeouts]) if (timer.at <= now) { timeouts.delete(id); timer.callback(); }
    },
  };
}

const reopened = browser({ entry: false });
assert.equal(reopened.window.AppLock.isLocked(), true);
assert.equal(reopened.document.documentElement.style.visibility, 'hidden');
assert.equal(reopened.redirects[0], 'login.html?locked=1');
assert.equal(reopened.storage.has('ctl'), false);
assert.equal(JSON.parse(reopened.storage.get('cfg')).pass, undefined);
assert.ok(reopened.calls.some((call) => call.url.endsWith('/api/login/lock')));
const blocked = await reopened.window.fetch('https://app.test/api/me');
assert.equal(blocked.status, 401);

const active = browser();
assert.equal(active.window.AppLock.isLocked(), false);
assert.equal(active.tab.has('app-entry'), false);
active.fire('document', 'pointerdown');
assert.ok(active.calls.some((call) => call.url.endsWith('/api/login/activity')));
active.advance(299_999);
assert.equal(active.window.AppLock.isLocked(), false);
active.advance(1);
assert.equal(active.window.AppLock.isLocked(), true, 'Five minutes idle locks the app');

const background = browser();
background.document.hidden = true;
background.fire('document', 'visibilitychange');
assert.ok(background.calls.some((call) => call.url.endsWith('/api/login/background')));
background.advance(60_000);
assert.equal(background.window.AppLock.isLocked(), true, 'One minute in background locks the app');

const brief = browser();
brief.document.hidden = true;
brief.fire('document', 'visibilitychange');
brief.advance(10_000);
brief.document.hidden = false;
brief.fire('document', 'visibilitychange');
assert.equal(brief.window.AppLock.isLocked(), false);
brief.fire('window', 'pagehide');
assert.equal(brief.window.AppLock.isLocked(), true, 'Leaving the page locks the session');

const update = browser();
update.window.AppLock.allowNavigation();
update.fire('window', 'pagehide');
assert.equal(update.window.AppLock.isLocked(), false, 'Source update reload preserves a fresh unlock');
assert.equal(update.tab.get('app-entry'), 'session-token');
update.fire('window', 'pageshow', { persisted: true });
assert.equal(update.window.AppLock.isLocked(), true, 'Back-forward cache does not bypass unlock');

const otherTab = browser();
otherTab.storage.set('session', JSON.stringify({ token: 'session-token', locked: true }));
otherTab.fire('window', 'storage', { key: 'session' });
assert.equal(otherTab.window.AppLock.isLocked(), true);
assert.equal(browser({ entry: false, demo: true }).window.AppLock.isLocked(), false);
console.log('Browser app lock smoke passed');