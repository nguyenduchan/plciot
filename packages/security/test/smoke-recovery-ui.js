import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client/recover.js', import.meta.url), 'utf8');
let checks = 0;
async function scenario(label, test) { await test(); checks++; console.log(`ok   ${label}`); }
async function browser({ ticket = null, status = 'pending_review', networkError = false, presence = false } = {}) {
  const elements = new Map();
  const storage = new Map(ticket ? [['recoveryTicket', ticket]] : []);
  const proofs = [];
  const requests = [];
  const state = { status, networkError, presence };
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { value: '', hidden: false, textContent: '', disabled: false });
    return elements.get(selector);
  };
  const context = vm.createContext({
    Response, URL, Date,
    window: {
      Security: { errText: (error) => error },
      SecurityDevice: { async proof(subject, action) { proofs.push({ subject, action }); return { deviceId: 'test-recovery-device', publicKey: {}, deviceProof: {} }; } },
    },
    document: { querySelector: element },
    location: { origin: 'https://recovery.test' },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setInterval: () => 1, clearInterval() {},
    async fetch(url, options) {
      const path = new URL(url).pathname;
      requests.push({ path, body: options?.body ? JSON.parse(options.body) : null });
      if (path === '/api/auth/config') return new Response(JSON.stringify({ presence: state.presence }));
      if (state.networkError) throw new TypeError('Failed to fetch');
      if (path === '/api/recovery/start') return new Response(JSON.stringify({ ok: true, id: 'recovery-test-id' }));
      return new Response(JSON.stringify({ ok: true, status: state.status, newPhone: '0987654321', executeAt: Date.now() + 86400_000 }));
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  return { element, storage, proofs, requests, state };
}

await scenario('Every accepted phone form signs the same canonical recovery identity', async () => {
  for (const phone of ['0987654321', '987654321', '+84 987 654 321', '0084987654321']) {
    const ui = await browser();
    ui.element('#old').value = '0912345678';
    ui.element('#new').value = phone;
    await ui.element('#go1').onclick();
    assert.equal(ui.proofs[0].subject, '84987654321', phone);
    assert.equal(ui.storage.get('recoveryTicket'), 'recovery-test-id');
  }
});

await scenario('Reloading an OTP-pending ticket restores the OTP step', async () => {
  const ui = await browser({ ticket: 'saved-ticket', status: 'pending_otp' });
  assert.equal(ui.storage.get('recoveryTicket'), 'saved-ticket');
  assert.equal(ui.element('#s2').hidden, false);
  assert.equal(ui.element('#s3').hidden, true);
});

await scenario('Temporary network failure preserves the ticket for retry', async () => {
  const ui = await browser({ ticket: 'saved-ticket', networkError: true });
  assert.equal(ui.storage.get('recoveryTicket'), 'saved-ticket');
  ui.state.networkError = false;
  await ui.element('#refresh').onclick();
  assert.equal(ui.element('#s3').hidden, false);
  assert.match(ui.element('#st').textContent, /chờ quản trị/);
});

await scenario('A webapp without a presence adapter never exposes a PLC proof action', async () => {
  const ui = await browser({ ticket: 'saved-ticket', presence: false });
  assert.equal(ui.element('#plc').hidden, true);
});

await scenario('Applied recovery directs the user to enroll on the original browser', async () => {
  const ui = await browser({ ticket: 'saved-ticket', status: 'applied' });
  assert.match(ui.element('#st').textContent, /chính trình duyệt này/);
  assert.equal(ui.storage.has('recoveryTicket'), false);
});

console.log(`Recovery UI: ${checks} scenario groups passed`);