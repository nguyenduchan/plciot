/**
 * THƯ VIỆN THIẾT BỊ MẪU (device template) cho cài đặt RS485 bằng điện thoại trên board Waveshare — docs/MOBILE-SETUP.md.
 *
 *   Kỹ sư (GatewayAdmin, ký khoá máy) ──PUT /api/v1/radmin/templates/:id──▶ bảng device_templates
 *   Board Waveshare ──GET /api/v1/device-templates──▶ danh sách gọn (cache trên flash) ──▶ trang /m trên điện thoại kỹ thuật viên
 *
 * Thợ lắp tủ chỉ chọn "loại thiết bị" + Slave ID + tên; mọi chi tiết thanh ghi (FC, địa chỉ, kiểu, thứ tự byte, hệ số) nằm ở đây.
 * Đọc công khai (không có bí mật: bảng thanh ghi của hãng là tài liệu công bố), có giới hạn tần suất; GHI chỉ máy GatewayAdmin đã đăng ký.
 * Xoá = đánh dấu deleted (không xoá dòng): board đang dùng mẫu vẫn chạy (cấu hình thiết bị đã chép xuống board, không tham chiếu server).
 */
import { audit, clientIp, rateLimit } from '@plciot/security';

export const TYPES = ['UInt16', 'Int16', 'UInt32', 'Int32', 'Float32', 'Float64', 'Bool'];
const WORDS = { UInt16: 1, Int16: 1, Bool: 1, UInt32: 2, Int32: 2, Float32: 2, Float64: 4 };
/** Thứ tự byte theo số word: AB = 16 bit bình thường, BA = đảo byte; 32/64 bit: ABCD (word cao trước), CDAB (đảo word), BADC (đảo byte), DCBA (cả hai). */
export const ORDERS = { 1: ['AB', 'BA'], 2: ['ABCD', 'CDAB', 'BADC', 'DCBA'], 4: ['ABCD', 'CDAB', 'BADC', 'DCBA'] };
export const KINDS = ['gauge', 'number', 'tank', 'toggle', 'slider'];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const KEY_RE = /^[A-Za-z0-9_]{1,32}$/;
const MAX_FIELDS = 64;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * Kiểm + chuẩn hoá một mẫu. Ném Error (câu tiếng Việt) khi sai. Trả object gọn đúng định dạng board dùng:
 * {id,name,brand,model,icon,note,serial:{baud,parity},test:[key],fields:[{key,label,fc,addr,type,order,scale,unit,access,kind,min,max,show,wfc,on,off}]}
 */
export function validateTemplate(t, idFromPath) {
  if (!t || typeof t !== 'object') throw new Error('Thân yêu cầu phải là JSON mẫu thiết bị.');
  const id = str(idFromPath ?? t.id, 48).toLowerCase();
  if (!ID_RE.test(id)) throw new Error('Mã mẫu chỉ gồm chữ thường, số, "-" (2–48 ký tự), ví dụ "invt-gd20".');
  const name = str(t.name, 60);
  if (!name) throw new Error('Thiếu tên hiển thị của mẫu (vd. "Biến tần INVT GD20").');
  const baud = Number(t.serial?.baud ?? 9600), parity = str(t.serial?.parity ?? 'None', 4);
  if (![1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(baud)) throw new Error('Tốc độ baud mặc định không hợp lệ.');
  if (!['None', 'Even', 'Odd'].includes(parity)) throw new Error('Parity mặc định phải là None, Even hoặc Odd.');
  const fields = Array.isArray(t.fields) ? t.fields : [];
  if (!fields.length) throw new Error('Mẫu chưa có thông số nào.');
  if (fields.length > MAX_FIELDS) throw new Error(`Tối đa ${MAX_FIELDS} thông số một mẫu.`);
  const seen = new Set();
  const out = fields.map((f, i) => {
    const line = `Dòng ${i + 1}`;
    const key = str(f.key, 32);
    if (!KEY_RE.test(key)) throw new Error(`${line}: khoá "${key}" chỉ gồm chữ, số, "_" (tối đa 32 ký tự).`);
    if (seen.has(key.toLowerCase())) throw new Error(`${line}: khoá "${key}" bị trùng.`);
    seen.add(key.toLowerCase());
    const label = str(f.label, 40) || key;
    const access = ['r', 'rw', 'w'].includes(f.access) ? f.access : 'r';
    const fc = Number(f.fc ?? 3);
    if (![3, 4].includes(fc)) throw new Error(`${line}: chỉ hỗ trợ đọc FC03 (holding) hoặc FC04 (input register).`);
    if (fc === 4 && access !== 'r') throw new Error(`${line}: thanh ghi FC04 (input) chỉ đọc được — dùng FC03 cho thông số ghi.`);
    const addr = Number(f.addr);
    const type = TYPES.includes(f.type) ? f.type : 'UInt16';
    const words = WORDS[type];
    if (!Number.isInteger(addr) || addr < 0 || addr + words > 65536) throw new Error(`${line}: địa chỉ thanh ghi phải từ 0 đến 65535.`);
    const order = str(f.order, 4).toUpperCase() || ORDERS[words][0];
    if (!ORDERS[words].includes(order)) throw new Error(`${line}: thứ tự byte "${order}" không hợp với kiểu ${type} (chọn ${ORDERS[words].join(', ')}).`);
    const scale = Number(f.scale ?? 1);
    if (!(scale > 0) || !Number.isFinite(scale)) throw new Error(`${line}: hệ số chia phải > 0 (giá trị = số thô ÷ hệ số).`);
    const min = num(f.min), max = num(f.max);
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) throw new Error(`${line}: Min/Max phải là số.`);
    if (min !== null && max !== null && min > max) throw new Error(`${line}: Min lớn hơn Max.`);
    const kind = KINDS.includes(f.kind) ? f.kind : (access === 'r' ? 'gauge' : 'slider');
    const wfc = access === 'r' ? 0 : Number(f.wfc || 0);
    if (![0, 6, 16].includes(wfc)) throw new Error(`${line}: lệnh ghi chỉ là 06 (một thanh ghi) hoặc 16 (nhiều thanh ghi).`);
    if (wfc === 6 && words > 1) throw new Error(`${line}: FC06 chỉ ghi được 1 thanh ghi — kiểu ${type} cần FC16.`);
    const o = { key, label, fc, addr, type, order, scale, unit: str(f.unit, 12), access, kind, show: f.show !== false };
    if (min !== null) o.min = min;
    if (max !== null) o.max = max;
    if (wfc) o.wfc = wfc;
    if (kind === 'toggle') { const on = str(f.on, 16), off = str(f.off, 16); if (on) o.on = on; if (off) o.off = off; }
    return o;
  });
  let test = (Array.isArray(t.test) ? t.test : []).map((k) => str(k, 32)).filter((k) => out.some((f) => f.key === k && f.access !== 'w'));
  test = [...new Set(test)].slice(0, 3);
  if (!test.length) test = out.filter((f) => f.access !== 'w').slice(0, 3).map((f) => f.key);
  if (!test.length) throw new Error('Mẫu cần ít nhất một thông số ĐỌC được (để thợ bấm "Đọc thử").');
  return {
    id, name, brand: str(t.brand, 32), model: str(t.model, 32), icon: str(t.icon, 16) || 'dev', note: str(t.note, 200),
    serial: { baud, parity }, test, fields: out,
  };
}

const migrated = new WeakSet();
export function migrateDeviceLibrary(db) {
  if (migrated.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_templates (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'rs485',
      body TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
  `);
  migrated.add(db);
}

/** Số hiệu thư viện = max(updated_at): board so với bản cache để biết có cần tải lại. */
export const libraryRev = (db) => Number(db.prepare('SELECT MAX(updated_at) AS r FROM device_templates').get()?.r || 0);

export function listTemplates(db, { includeDeleted = false } = {}) {
  return db.prepare(`SELECT id, body, rev, deleted, updated_at, updated_by FROM device_templates ${includeDeleted ? '' : 'WHERE deleted = 0'} ORDER BY id`).all()
    .map((r) => ({ ...JSON.parse(r.body), rev: r.rev, deleted: Boolean(r.deleted), updatedAt: r.updated_at, updatedBy: r.updated_by }));
}

export function putTemplate(db, tpl, by) {
  const now = Math.max(Date.now(), libraryRev(db) + 1);   // luôn tăng (hai lần lưu trong cùng ms vẫn đổi rev thư viện)
  db.prepare(`INSERT INTO device_templates (id, kind, body, rev, deleted, updated_at, updated_by) VALUES (?, 'rs485', ?, 1, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body, rev = rev + 1, deleted = 0, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(tpl.id, JSON.stringify(tpl), now, by);
  return db.prepare('SELECT rev FROM device_templates WHERE id = ?').get(tpl.id).rev;
}

export function mountDeviceLibrary(app, { db, admin }) {
  migrateDeviceLibrary(db);
  const pub = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_TEMPLATES || 30), keyFn: (req) => `${clientIp(req)}:tpl` });
  const bad = (res, status, error, detail) => res.status(status).json({ error, ...(detail ? { detail } : {}) });

  /** Board (và ai cũng được): danh sách mẫu đang dùng. ?since=<rev> trùng rev hiện tại → 304 không thân (board giữ cache). */
  app.get('/api/v1/device-templates', pub, (req, res) => {
    const rev = libraryRev(db);
    if (req.query.since && Number(req.query.since) === rev) return res.status(304).end();
    const templates = listTemplates(db).map(({ rev: _r, deleted: _d, updatedAt: _u, updatedBy: _b, ...t }) => t);
    res.set('Cache-Control', 'no-store').json({ rev, templates });
  });

  // ---- GatewayAdmin (ký khoá máy, remoteAdmin.js)
  app.get('/api/v1/radmin/templates', admin.limit, admin.requireAdminKey, (_req, res) => {
    res.json({ rev: libraryRev(db), templates: listTemplates(db, { includeDeleted: true }) });
  });

  app.put('/api/v1/radmin/templates/:id', admin.limit, admin.requireAdminKey, (req, res) => {
    let tpl;
    try { tpl = validateTemplate(req.body, req.params.id); } catch (e) { return bad(res, 400, 'template_invalid', e.message); }
    const rev = putTemplate(db, tpl, req.radmin.label);
    audit(db, 'template_put', { ip: clientIp(req), detail: `${req.radmin.label} ${tpl.id} rev ${rev} (${tpl.fields.length} thông số)` });
    res.json({ ok: true, id: tpl.id, rev, template: tpl });
  });

  app.delete('/api/v1/radmin/templates/:id', admin.limit, admin.requireAdminKey, (req, res) => {
    const id = String(req.params.id || '').toLowerCase();
    const now = Math.max(Date.now(), libraryRev(db) + 1);
    const r = db.prepare('UPDATE device_templates SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ? AND deleted = 0').run(now, req.radmin.label, id);
    if (!r.changes) return bad(res, 404, 'template_not_found');
    audit(db, 'template_delete', { ip: clientIp(req), detail: `${req.radmin.label} ${id}` });
    res.json({ ok: true });
  });
}
