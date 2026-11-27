/**
 * Ánh xạ payload của gateway no-code (mua sẵn, chỉ cấu hình) → telemetry chuẩn { d: { child: { field: số } } },
 * và (giai đoạn 4) lệnh đã kiểm ở server → bản tin lệnh của hãng + phản hồi của hãng → ack.
 * Thuần (không DB/MQTT) để test riêng. Thiết kế: docs/NOCODE-GATEWAY.md.
 *
 * Map = đúng dạng `config` của gateway (devices/fields/lbl/unit/widget…) + thuộc tính TRÍCH XUẤT trên từng field:
 *   { "v":1, "mode":"object"|"list", "list":"$.values", "name":"n", "value":"v", "ts":"$.time",
 *     "devices":[ { "id":"bom1", "name":"Bơm 1", "fields":[
 *        { "key":"dong", "lbl":"Dòng", "unit":"A", "widget":"gauge", "path":"$.data.I1", "scale":0.1, "offset":0 },
 *        { "key":"chay", "widget":"led_status", "name":"DI1" } ] } ] }   // mode list: "name" = tên điểm trong mảng
 * Đường dẫn: tập con JSONPath — $, .ten, [số], ['ten bat ky'] — không filter/wildcard/biểu thức.
 */
import { sanitizeConfig, MAX_CONFIG_BYTES } from './gatewayConfig.js';

const MAX_DEPTH = 8;
const MAX_LIST = 1024;
const SEG = /^[A-Za-z0-9_\-:@$]{1,64}/;
const POINT = /^[A-Za-z0-9_\-.:@/ ]{1,64}$/;      // tên điểm trong mode list / tên thuộc tính của phần tử
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

/** "$.a.b[0]['x y']" → ['a','b',0,'x y'] hoặc null nếu sai cú pháp. */
export function parsePath(raw) {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('$') || s.length > 200) return null;
  const out = [];
  let i = 1;
  while (i < s.length) {
    if (out.length >= MAX_DEPTH) return null;
    const c = s[i];
    if (c === '.') {
      const m = SEG.exec(s.slice(i + 1));
      if (!m) return null;
      out.push(m[0]); i += 1 + m[0].length;
    } else if (c === '[') {
      const rest = s.slice(i);
      let m = /^\[(\d{1,4})\]/.exec(rest);
      if (m) { out.push(Number(m[1])); i += m[0].length; continue; }
      m = /^\['([^'\\]{1,64})'\]/.exec(rest) || /^\["([^"\\]{1,64})"\]/.exec(rest);
      if (!m) return null;
      out.push(m[1]); i += m[0].length;
    } else return null;
  }
  if (out.some((k) => typeof k === 'string' && FORBIDDEN.has(k))) return null;
  return out;
}

/** Đọc giá trị theo đường dẫn đã parse — chỉ thuộc tính RIÊNG của object (không đi vào prototype). */
export function readPath(obj, segs) {
  let cur = obj;
  for (const k of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (typeof k === 'number') { if (!Array.isArray(cur)) return undefined; cur = cur[k]; continue; }
    if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const ON = new Set(['1', 'on', 'true', 'yes', 'run', 'open']);
const OFF = new Set(['0', 'off', 'false', 'no', 'stop', 'close', 'closed']);

/** Giá trị thô của hãng → số hữu hạn (bool/chuỗi số/"on"/"off"), không được → undefined. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (!t || t.length > 32) return undefined;
    if (ON.has(t)) return 1;
    if (OFF.has(t)) return 0;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const fin = (v) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * Kiểm tra + chuẩn hoá map người dùng gửi lên.
 * @returns {{ ok:true, map, config:{devices} } | { error }}
 */
export function sanitizeMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'map_not_object' };
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(raw)); } catch { return { error: 'map_invalid' }; }
  if (size > MAX_CONFIG_BYTES) return { error: 'map_too_large' };
  const mode = raw.mode === 'list' ? 'list' : 'object';
  const map = { v: 1, mode, devices: [] };
  if (mode === 'list') {
    if (!parsePath(raw.list)) return { error: 'map_bad_list_path' };
    map.list = String(raw.list).trim();
    const name = String(raw.name ?? 'name').trim(); const value = String(raw.value ?? 'value').trim();
    if (!POINT.test(name) || !POINT.test(value) || FORBIDDEN.has(name) || FORBIDDEN.has(value)) return { error: 'map_bad_list_keys' };
    map.name = name; map.value = value;
  }
  if (raw.ts != null && raw.ts !== '') {
    if (!parsePath(raw.ts)) return { error: 'map_bad_ts_path' };
    map.ts = String(raw.ts).trim();
  }
  // Điều khiển (giai đoạn 4): chỉ khi map khai báo kiểu lệnh của hãng. Hiện hỗ trợ: usr_rw_prot (USR-M100 — JSON "rw_prot" của họ gateway USR).
  const ctl = sanitizeControl(raw.control);
  if (ctl?.error) return ctl;
  if (ctl) map.control = ctl;
  // Phần hiển thị dùng đúng bộ lọc của `config` (cùng giới hạn id/key/số lượng). writable chỉ giữ khi có điều khiển + điểm ghi.
  const devicesIn = Array.isArray(raw.devices) ? raw.devices : null;
  if (!devicesIn) return { error: 'map_devices_missing' };
  const canWrite = (f) => Boolean(ctl) && f?.writable === true && POINT.test(String(f?.point ?? '').trim());
  const view = sanitizeConfig({
    devices: devicesIn.map((d) => ({ ...d, fields: (Array.isArray(d?.fields) ? d.fields : []).map((f) => ({ ...f, writable: canWrite(f) })) })),
  });
  if (view.error) return { error: view.error };
  for (const dv of view.devices) {
    const src = devicesIn.find((d) => String(d?.id ?? '').trim() === dv.id);
    const fields = [];
    for (const f of dv.fields) {
      const sf = (src?.fields || []).find((x) => String(x?.key ?? '').trim() === f.key) || {};
      const out = { ...f };
      // Field ghi được có thể không có giá trị đọc về (đầu ra thuần): khi đó không cần path/name
      const optional = out.writable && (mode === 'list' ? sf.name == null || sf.name === '' : sf.path == null || sf.path === '');
      if (mode === 'list') {
        const nm = String(sf.name ?? '').trim();
        if (!optional && !POINT.test(nm)) return { error: 'map_bad_point_name', device: dv.id, key: f.key };
        if (!optional) out.name = nm;
      } else if (!optional) {
        if (!parsePath(sf.path)) return { error: 'map_bad_path', device: dv.id, key: f.key };
        out.path = String(sf.path).trim();
      }
      if (out.writable) out.point = String(sf.point).trim();
      const scale = fin(sf.scale); const offset = fin(sf.offset);
      if (scale !== undefined && scale !== 1) out.scale = scale;
      if (offset !== undefined && offset !== 0) out.offset = offset;
      fields.push(out);
    }
    map.devices.push({ ...dv, fields });
  }
  // Config cho dashboard = map bỏ thuộc tính trích xuất / điểm ghi của hãng
  const config = {
    devices: map.devices.map((d) => ({
      ...d,
      fields: d.fields.map(({ path, name, scale, offset, point, ...rest }) => rest),   // eslint-disable-line no-unused-vars
    })),
  };
  return { ok: true, map, config };
}

export const CONTROL_PRESETS = Object.freeze(['usr_rw_prot']);

/** "usr_rw_prot" | { preset, valueType: 'string'|'number', timeoutMs } → chuẩn hoá; không khai báo → null. */
export function sanitizeControl(raw) {
  if (raw == null || raw === '' || raw === false) return null;
  const o = typeof raw === 'string' ? { preset: raw } : raw;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'map_bad_control' };
  const preset = String(o.preset ?? '').trim();
  if (!CONTROL_PRESETS.includes(preset)) return { error: 'map_bad_control' };
  const valueType = o.valueType === 'number' ? 'number' : 'string';   // sổ tay USR-M100 ghi "value":"15" (chuỗi)
  const t = Number(o.timeoutMs);
  const timeoutMs = Number.isFinite(t) ? Math.min(30_000, Math.max(1000, Math.round(t))) : 8000;
  return { preset, valueType, timeoutMs };
}

/** Field ghi được của map: { point } theo (child, key), không có → null. */
export function writePoint(map, child, key) {
  const dev = (map?.devices || []).find((d) => d.id === child);
  const f = dev?.fields?.find((x) => x.key === key);
  return f?.writable && f.point ? f.point : null;
}

/**
 * Lệnh đã kiểm tra ở server ({ id, child, key, v }) → bản tin của hãng.
 * Chỉ thay giá trị số đã qua limits; tên điểm do chủ trạm khai trong map (đã lọc) → không chèn chuỗi người dùng.
 */
export function renderCommand(control, { id, point, v }) {
  if (control?.preset === 'usr_rw_prot') {
    const value = control.valueType === 'number' ? Number(v) : String(v);
    return { rw_prot: { Ver: '1.0.1', dir: 'down', id: String(id), w_data: [{ name: point, value }] } };
  }
  return null;
}

/**
 * Phản hồi của hãng → { id|null, ok, err? }. null = không phải phản hồi hợp lệ.
 * usr_rw_prot: {"rw_prot":{"Ver":"1.0.1","dir":"up","id":"…","w_data":[{"name","value","err":"0"}]}};
 * lỗi giao thức: {"rw_prot":{"Ver":"1.0.1","dir":"up","err":"1"}} (không có id).
 */
export function parseReply(control, payload) {
  if (control?.preset === 'usr_rw_prot') {
    const r = payload?.rw_prot;
    if (!r || typeof r !== 'object' || String(r.dir).toLowerCase() !== 'up') return null;
    const id = r.id != null && String(r.id).trim() ? String(r.id).trim().slice(0, 32) : null;
    const isErr = (e) => e != null && String(e).trim() !== '0';
    if (isErr(r.err)) return { id, ok: false, err: 'gateway_error' };
    const w = Array.isArray(r.w_data) ? r.w_data : [];
    if (!w.length) return id ? { id, ok: false, err: 'gateway_error' } : null;
    const bad = w.some((x) => isErr(x?.err));
    return bad ? { id, ok: false, err: 'write_failed' } : { id, ok: true };
  }
  return null;
}

/** Mốc thời gian trong payload → ms epoch (giây hoặc ms hoặc chuỗi ngày), không hợp lệ → undefined. */
export function toEpochMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return toEpochMs(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Áp map (đã sanitize) lên payload đã parse.
 * @returns {{ d: object, n: number, bad: string[], ts?: number }}  bad = "child.key" không đọc được
 */
export function applyMap(map, payload) {
  const d = {}; const bad = []; let n = 0;
  let points = null;
  if (map.mode === 'list') {
    points = new Map();
    const arr = readPath(payload, parsePath(map.list) || []);
    if (Array.isArray(arr)) {
      for (const it of arr.slice(0, MAX_LIST)) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
        if (!Object.prototype.hasOwnProperty.call(it, map.name)) continue;
        points.set(String(it[map.name]), Object.prototype.hasOwnProperty.call(it, map.value) ? it[map.value] : undefined);
      }
    }
  }
  for (const dev of map.devices || []) {
    for (const f of dev.fields || []) {
      if (points ? f.name == null : f.path == null) continue;   // đầu ra thuần (chỉ ghi, không đọc về)
      const raw = points ? points.get(f.name) : readPath(payload, parsePath(f.path) || []);
      let v = toNumber(raw);
      if (v === undefined) { bad.push(`${dev.id}.${f.key}`); continue; }
      v = round6(v * (f.scale ?? 1) + (f.offset ?? 0));
      if (!Number.isFinite(v)) { bad.push(`${dev.id}.${f.key}`); continue; }
      (d[dev.id] ||= {})[f.key] = v;
      n += 1;
    }
  }
  const out = { d, n, bad };
  if (map.ts) {
    const ts = toEpochMs(readPath(payload, parsePath(map.ts) || []));
    if (ts !== undefined) out.ts = ts;
  }
  return out;
}
