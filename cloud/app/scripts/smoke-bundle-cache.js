import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const origin = 'https://plciot.test';
const stores = new Map();
const storage = new Map();
const elements = new Map();
const downloads = [];
let failPath = null;
const caches = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    const key = (url) => new URL(url.url || url, origin).href;
    return {
      async match(url) { return entries.get(key(url))?.clone(); },
      async put(url, response) { entries.set(key(url), response.clone()); },
    };
  },
  async keys() { return [...stores.keys()]; },
  async delete(name) { return stores.delete(name); },
};
const context = vm.createContext({
  URL, Response, Headers, caches,
  window: { caches },
  navigator: {},
  location: { origin, protocol: 'https:', replace() {} },
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
  },
  document: {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { classList: { add() {} }, style: {} });
      return elements.get(selector);
    },
  },
  setTimeout(callback) { callback(); },
  async fetch(url, options) {
    downloads.push({ url, token: options.headers.Authorization });
    return new Response(url, { status: url.endsWith(failPath) ? 503 : 200 });
  },
});
const source = readFileSync(new URL('../../../packages/security/client/login.js', import.meta.url), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('\nasync function api(')), context);
const login = vm.runInContext('finishLogin', context);
const bundle = {
  userId: 'user-a', version: 'source-v1', token: 'first-token',
  files: [{ path: 'index.html' }, { path: 'app.js' }, { path: 'style.css' }],
};

await login(bundle);
assert.equal(downloads.length, 3, 'First login downloads the bundle');
await login({ ...bundle, token: 'new-otp-token' });
assert.equal(downloads.length, 3, 'Repeated OTP login reuses the same source version');
assert.equal(JSON.parse(storage.get('session')).token, 'new-otp-token');

stores.get('plc-user-a-source-v1').delete(`${origin}/app.js`);
await login(bundle);
assert.equal(downloads.length, 4, 'Only the missing file is downloaded');
assert.equal(downloads.at(-1).url, `${origin}/api/bundle/app.js`);

const updated = { ...bundle, version: 'source-v2' };
failPath = '/app.js';
await assert.rejects(login(updated), /503/);
assert.equal(JSON.parse(storage.get('session')).version, 'source-v1');
assert.equal((await (await caches.open('plc-meta')).match('/active')).status, 200);
assert.equal((await (await (await caches.open('plc-meta')).match('/active')).json()).version, 'source-v1');
assert.ok(stores.has('plc-user-a-source-v1'), 'Failed update preserves the active bundle');

failPath = null;
const beforeRetry = downloads.length;
await login(updated);
assert.equal(downloads.length - beforeRetry, 2, 'Retry downloads only unfinished files');
assert.equal(JSON.parse(storage.get('session')).version, 'source-v2');
assert.ok(!stores.has('plc-user-a-source-v1'), 'Successful update removes the old bundle');

const beforeOtherUser = downloads.length;
await login({ ...updated, userId: 'user-b' });
assert.equal(downloads.length - beforeOtherUser, 3, 'A different account gets its own bundle');
const workerEvents = new Map();
const revalidations = [];
let offline = false;
const active = await caches.open('plc-user-b-source-v2');
await active.put(`${origin}/security/login.js`, new Response('cached-auth'));
const worker = vm.createContext({
  URL, Response, caches,
  self: { location: { origin }, addEventListener: (event, handler) => workerEvents.set(event, handler) },
  async fetch(request, options) {
    revalidations.push({ url: request.url, cache: options?.cache });
    if (offline) throw new Error('offline');
    return new Response('fresh-auth');
  },
});
vm.runInContext(readFileSync(new URL('../../../webapp/sw.js', import.meta.url), 'utf8'), worker);
const requestFile = async (path) => {
  let response;
  workerEvents.get('fetch')({ request: new Request(origin + path), respondWith(value) { response = value; } });
  return response;
};
assert.equal(await (await requestFile('/security/login.js')).text(), 'fresh-auth');
assert.equal(revalidations.at(-1).cache, 'no-cache', 'Auth shell revalidates through HTTP cache/ETag');
const beforeCachedApp = revalidations.length;
await requestFile('/app.js');
assert.equal(revalidations.length, beforeCachedApp, 'Unchanged app bundle stays cache-first');
offline = true;
assert.equal(await (await requestFile('/security/login.js')).text(), 'cached-auth', 'Offline auth shell can fall back to its bundle');
console.log('Bundle cache smoke passed');