/**
 * Proof of physical presence at the site: the user must flip a chosen PLC input
 * (D0 bit) within a short window. Telemetry already flows gw → MQTT → ingest, so
 * the server just watches D0 transitions. Modbus has no auth, so this is a
 * *supporting* factor (admin evidence), never a stand-alone one.
 */

const FRESH_MS = 15_000;
const state = new Map(); // "site/device" -> { t, d0, changed: number[8] (ts of last edge per bit) }

export function noteTelemetry(site, device, d0, now = Date.now()) {
  const key = `${site}/${device}`;
  let s = state.get(key);
  if (!s) {
    s = { t: now, d0, changed: new Array(8).fill(0) };
    state.set(key, s);
    return;
  }
  const diff = (s.d0 ^ d0) & 0xff;
  if (diff) for (let b = 0; b < 8; b++) if (diff & (1 << b)) s.changed[b] = now;
  s.d0 = d0;
  s.t = now;
}

export function plcSnapshot(site, device, now = Date.now()) {
  const s = state.get(`${site}/${device}`);
  if (!s) return { fresh: false };
  return { fresh: now - s.t < FRESH_MS, d0: s.d0, t: s.t };
}

export function edgeSince(site, device, bit, sinceTs) {
  const s = state.get(`${site}/${device}`);
  return Boolean(s && s.changed[bit] > sinceTs);
}

/** Avoid X3 (count sensor) by default; override with PLC_PROOF_BITS="0,1,2". */
export function pickProofBit() {
  const list = String(process.env.PLC_PROOF_BITS || '0,1,2,4,5,6,7')
    .split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n < 8);
  const pool = list.length ? list : [0];
  return pool[Math.floor(Math.random() * pool.length)];
}
