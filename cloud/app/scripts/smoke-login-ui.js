import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../../packages/security/client/login.js', import.meta.url), 'utf8');
let checks = 0;
async function scenario(label, test) {
  await test();
  console.log(`ok   ${label}`);
  checks++;
}

async function browser({ offlineBundle = false, session = null } = {}) {
  const elements = new Map();
  const storage = new Map(session ? [['session', JSON.stringify(session)]] : []);
  const redirects = [];
  const requests = [];
  const replies = new Map();
  const intervals = new Map();
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const element = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        value: '', textContent: '', hidden: ['#step-otp', '#ok-msg', '#btn-resume', '#btn-passkey'].includes(selector), disabled: false,
        classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value), toggle() {} },
        style: {}, focus() {},
      });
    }
    return elements.get(selector);
  };
  const full = { token: 'full-token', userId: 7, role: 'viewer', version: 'v1', files: [{ path: 'index.html' }] };
  const ctl = {
    devId: () => 'ui-test-device', passkeySupported: () => false,
    errText: (error) => error || 'Lỗi',
    completeOtp: async () => full, loginWithPasskey: async () => full, resumeLogin: async () => full,
  };
  const caches = {
    has: async () => true, keys: async () => [], delete: async () => true,
    open: async () => ({ match: async () => undefined, put: async () => {} }),
  };
  const context = vm.createContext({
    URL, URLSearchParams, Response, Headers, caches, Date: Clock,
    window: { Security: ctl, ...(offlineBundle ? { caches } : {}) }, navigator: {},
    location: { origin: 'https://ui.test', protocol: 'https:', search: '', replace: (url) => redirects.push(url) },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key),
    },
    sessionStorage: { setItem() {} },
    document: { querySelector: element, querySelectorAll: () => [] },
    setTimeout: (callback) => { callback(); return 1; },
    setInterval: (callback) => { const id = intervals.size + 1; intervals.set(id, callback); return id; },
    clearInterval: (id) => intervals.delete(id),
    async fetch(url, options) {
      const path = new URL(url).pathname;
      requests.push({ path, body: options?.body ? JSON.parse(options.body) : null });
      const response = replies.get(path);
      if (response instanceof Error) throw response;
      if (response) return new Response(JSON.stringify(response.body), { status: response.status });
      if (path === '/api/auth/config') return new Response(JSON.stringify({ telegram: true }));
      if (path === '/api/login/request-otp') return new Response(JSON.stringify({ phone: '84987654321', purpose: 'login' }));
      if (path.includes('/verify')) return new Response(JSON.stringify({ pending: true, token: 'pending-token' }));
      return new Response('bundle');
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  const request = async (phone = '0987654321') => { element('#phone').value = phone; await element('#btn-otp').onclick(); };
  const verify = async (code = '123456') => { element('#otp').value = code; await element('#btn-verify').onclick(); };
  return { element, storage, requests, replies, redirects, ctl, intervals, request, verify, context, full,
    advance(ms) { now += ms; for (const tick of intervals.values()) tick(); },
  };
}

await scenario('Initial login clears errors even with the core error translator', async () => {
  const ui = await browser();
  assert.equal(ui.element('#error').textContent, '');
});

await scenario('Bundle failure restores login controls and hides false success', async () => {
  const ui = await browser({ offlineBundle: true });
  ui.replies.set('/api/bundle/index.html', { status: 503, body: {} });
  await ui.request();
  await ui.verify();
  assert.equal(ui.redirects.length, 0);
  assert.equal(ui.storage.has('session'), false);
  assert.equal(ui.element('#step-creds').hidden, false, 'Login controls must remain reachable after download failure');
  assert.equal(ui.element('#ok-msg').hidden, true);
  assert.equal(ui.element('#progress').classList.contains('on'), false);
});

await scenario('Invalid phones do not call the OTP API', async () => {
  for (const phone of ['', '123', '0123456789', '+11234567890']) {
    const ui = await browser();
    await ui.request(phone);
    assert.equal(ui.requests.filter((request) => request.path === '/api/login/request-otp').length, 0);
    assert.ok(ui.element('#error').textContent);
  }
});

await scenario('Valid phone formats normalize and show OTP with resend locked', async () => {
  for (const phone of ['0987654321', '987654321', '+84 987 654 321']) {
    const ui = await browser();
    await ui.request(phone);
    assert.equal(ui.requests.at(-1).body.phone, '84987654321');
    assert.equal(ui.element('#step-otp').hidden, false);
    assert.equal(ui.element('#btn-resend').disabled, true);
    assert.equal(ui.element('#btn-otp').disabled, false);
  }
});

await scenario('Request errors stay on the phone step and restore buttons', async () => {
  for (const error of ['telegram_not_linked', 'account_disabled', 'registration_closed', 'rate_limited', 'telegram_send_failed']) {
    const ui = await browser();
    ui.replies.set('/api/login/request-otp', { status: 400, body: { error } });
    await ui.request();
    assert.equal(ui.element('#step-otp').hidden, true);
    assert.ok(ui.element('#error').textContent);
    assert.equal(ui.element('#btn-otp').disabled, false);
  }
});

await scenario('Empty and malformed OTP never consumes verification attempts', async () => {
  for (const code of ['', '12345', 'abcdef', '1234567']) {
    const ui = await browser();
    await ui.request();
    await ui.verify(code);
    assert.equal(ui.requests.filter((request) => request.path === '/api/login/verify-otp').length, 0);
    assert.ok(ui.element('#error').textContent);
  }
});

await scenario('Wrong, expired, missing and locked OTP stay out of the app', async () => {
  for (const error of ['otp_invalid', 'otp_expired', 'otp_missing', 'otp_locked', 'account_disabled']) {
    const ui = await browser();
    await ui.request();
    ui.replies.set('/api/login/verify-otp', { status: 401, body: { error } });
    await ui.verify();
    assert.equal(ui.redirects.length, 0);
    assert.equal(ui.element('#step-otp').hidden, false);
    assert.equal(ui.element('#btn-verify').disabled, false);
  }
});

await scenario('Cancelling or failing the second factor returns to a usable login step', async () => {
  for (const failure of ['cancel', 'expired', 'offline']) {
    const ui = await browser();
    ui.ctl.completeOtp = async () => { if (failure === 'cancel') return null; throw new Error(failure); };
    await ui.request();
    await ui.verify();
    assert.equal(ui.redirects.length, 0);
    assert.equal(ui.storage.has('session'), false);
    assert.equal(ui.element('#step-creds').hidden, false);
    assert.equal(ui.element('#ok-msg').hidden, true);
  }
});

await scenario('OTP and registration require the second factor before navigation', async () => {
  for (const purpose of ['login', 'register']) {
    const ui = await browser();
    ui.replies.set('/api/login/request-otp', { status: 200, body: { phone: '84987654321', purpose } });
    let verified = false;
    ui.ctl.completeOtp = async () => { assert.equal(ui.storage.has('session'), false); verified = true; return ui.full; };
    await ui.request();
    await ui.verify();
    assert.ok(verified);
    assert.equal(ui.redirects[0], 'index.html');
    assert.ok(ui.requests.some((request) => request.path === (purpose === 'register' ? '/api/register/verify' : '/api/login/verify-otp')));
  }
});

await scenario('Back and a new OTP clear the previously typed code', async () => {
  const ui = await browser();
  await ui.request();
  ui.element('#otp').value = '999999';
  ui.element('#btn-back').onclick();
  await ui.request();
  assert.equal(ui.element('#otp').value, '');
});

await scenario('Passkey cancellation, rejection and download failure preserve retry controls', async () => {
  for (const failure of ['cancel', 'unknown_credential', 'download']) {
    const ui = await browser({ offlineBundle: failure === 'download' });
    ui.ctl.loginWithPasskey = async () => {
      if (failure === 'cancel') throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
      return failure === 'unknown_credential' ? { error: failure } : ui.full;
    };
    if (failure === 'download') ui.replies.set('/api/bundle/index.html', { status: 503, body: {} });
    await vm.runInContext('passkeyLogin(false)', ui.context);
    assert.equal(ui.redirects.length, 0);
    assert.equal(ui.element('#step-creds').hidden, false);
    assert.equal(ui.element('#ok-msg').hidden, true);
    assert.equal(ui.element('#btn-otp').disabled, false);
  }
});

await scenario('Existing session never auto-enters; cancelled resume stays on login', async () => {
  const ui = await browser({ session: { token: 'old-token', userId: 7, online: true } });
  assert.equal(ui.redirects.length, 0);
  assert.equal(ui.element('#btn-resume').hidden, false);
  ui.ctl.resumeLogin = async () => null;
  await ui.element('#btn-resume').onclick();
  assert.equal(ui.redirects.length, 0);
  assert.equal(ui.element('#btn-resume').disabled, false);
});

await scenario('OTP countdown and resend follow elapsed time after tab suspension', async () => {
  const ui = await browser();
  await ui.request();
  ui.advance(60_000);
  assert.equal(ui.element('#btn-resend').disabled, false);
  ui.advance(240_000);
  assert.match(ui.element('#otp-timer').textContent, /Mã đã hết hạn/);
  assert.equal(ui.intervals.size, 0);
});

await scenario('Network failures never navigate or hide retry controls', async () => {
  const ui = await browser();
  ui.replies.set('/api/login/request-otp', new TypeError('Failed to fetch'));
  await ui.request();
  assert.match(ui.element('#error').textContent, /Không kết nối/);
  assert.equal(ui.element('#btn-otp').disabled, false);
  ui.replies.delete('/api/login/request-otp');
  await ui.request();
  ui.replies.set('/api/login/verify-otp', new TypeError('Failed to fetch'));
  await ui.verify();
  assert.equal(ui.element('#step-otp').hidden, false);
  assert.equal(ui.redirects.length, 0);
});

await scenario('Double submit cannot start another login while step two is pending', async () => {
  const ui = await browser();
  let finish;
  ui.ctl.completeOtp = () => new Promise((resolve) => { finish = resolve; });
  await ui.request();
  const first = ui.verify();
  await new Promise(setImmediate);
  await ui.verify();
  await ui.request();
  assert.equal(ui.requests.filter((request) => request.path === '/api/login/verify-otp').length, 1);
  finish(null);
  await first;
  assert.equal(ui.element('#btn-otp').disabled, false);
});

await scenario('Passkey and resumed login succeed without OTP; failed resume remains retryable', async () => {
  const passkey = await browser();
  await vm.runInContext('passkeyLogin()', passkey.context);
  assert.equal(passkey.redirects[0], 'index.html');
  assert.equal(passkey.requests.filter((request) => request.path.includes('otp')).length, 0);
  const resume = await browser({ session: { token: 'old-token', userId: 7, online: true } });
  resume.ctl.resumeLogin = async () => { throw new Error('Phiên đăng nhập hết hạn.'); };
  await resume.element('#btn-resume').onclick();
  assert.equal(resume.redirects.length, 0);
  assert.equal(resume.element('#step-creds').hidden, false);
  resume.ctl.resumeLogin = async () => resume.full;
  await resume.element('#btn-resume').onclick();
  assert.equal(resume.redirects[0], 'index.html');
});

console.log(`Login UI: ${checks} scenario groups passed`);