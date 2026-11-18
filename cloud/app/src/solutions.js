import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { listBundleFiles, copyDir } from './bundle.js';
import { shellVersion } from './bundleSync.js';

/**
 * Giải pháp (kiểu webapp) theo user. Mỗi giải pháp là MỘT THƯ MỤC ĐỘC LẬP: solutions/<id>/ (có thể phát triển ở repo khác,
 * chép vào VPS là server tự nhận — không sửa code server):
 *    solution.json   { kind:'plciot-solution' (DẤU NHẬN DIỆN: thiếu thì server bỏ qua thư mục), title, themeColor, mode:'overlay'|'full', inject:{css:[],js:[]} }
 *    webapp/         file giao diện của giải pháp
 *    gateway/        (tuỳ chọn) ui.json = giao diện gateway dạng dữ liệu (+ setup.json bản khai); webapp và gateway ở thư mục RIÊNG,
 *                    giải pháp có thể chỉ có một trong hai — admin thấy rõ phần nào có (parts) và tự đồng bộ vào ô chọn
 *  - 'basic' = thư mục shell (webapp/) — đúng như trước đây, không đổi byte nào.
 *  - mode 'overlay' (mặc định): webapp/ của giải pháp chồng lên shell (file trùng tên thì giải pháp thắng); `inject` chèn
 *    thêm CSS/JS vào index.html. Mode 'full': bundle chỉ gồm file của giải pháp (webapp độc lập hoàn toàn).
 *  Thư mục gốc: env SOLUTIONS_DIR (mặc định <cha của shell>/solutions).
 * Mã dùng chung (đăng nhập, bảo mật, chat, thiết bị…) chỉ nằm ở một nơi nên các giải pháp không bị lệch nhau.
 * User nào dùng giải pháp nào: cột users.solution (admin đặt cứng); trống → DEFAULT_SOLUTION (env) → 'basic'.
 */
export const BASIC = 'basic';
export const MARKER = 'plciot-solution';   // solution.json → "kind": "plciot-solution"
const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const SKIP = new Set(['.ds_store', 'thumbs.db', 'solution.json']);

export const solutionsRoot = (shellDir) => path.resolve(process.env.SOLUTIONS_DIR || path.join(path.dirname(path.resolve(shellDir)), 'solutions'));
export const solutionDir = (shellDir, id) => path.join(solutionsRoot(shellDir), id);
export const overlayDir = (shellDir, id) => path.join(solutionDir(shellDir, id), 'webapp');

/** Sổ đăng ký các mục trong ô chọn (admin thêm/sửa): <DATA_DIR>/solutions.json  { items:[{id,title,folder,enabled}] }.
 *  Mục (id) → thư mục (folder) trong solutions/. users.solution lưu id của mục. Chưa có file = tự liệt kê mọi thư mục (như trước). */
export const registryPath = () => path.resolve(process.env.SOLUTIONS_REGISTRY || path.join(process.env.DATA_DIR || './data', 'solutions.json'));
let regCache = { key: '', items: null };
function loadRegistry() {
  const p = registryPath();
  let st; try { st = fs.statSync(p); } catch { regCache = { key: '', items: null }; return null; }
  const key = `${p}:${st.mtimeMs}:${st.size}`;
  if (regCache.key === key) return regCache.items;
  let items = null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(j.items)) items = j.items.filter((x) => x && ID_RE.test(x.id) && x.id !== BASIC && ID_RE.test(x.folder)).map((x) => ({ id: x.id, title: String(x.title || x.id), folder: x.folder, enabled: x.enabled !== false }));
  } catch { /* file hỏng → coi như chưa có sổ */ }
  regCache = { key, items };
  return items;
}
function saveRegistry(items) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify({ items }, null, 2));
  fs.renameSync(`${p}.tmp`, p);
  regCache = { key: '', items: null };
}

/** Thư mục có DẤU NHẬN DIỆN (solution.json kind = plciot-solution) mới được coi là giải pháp. */
const isMarked = (shellDir, id) => readMeta(shellDir, id).kind === MARKER;

/** Phần của giải pháp: webapp (thư mục webapp/ có file) và gateway (gateway/ui.json hoặc mã C# riêng). Hai phần ở thư mục riêng, có thể chỉ có một. */
export function partsOf(shellDir, id) {
  const gw = path.join(solutionDir(shellDir, id), 'gateway');
  let hasFiles = false, hasCs = false;
  try { hasFiles = listBundleFiles(overlayDir(shellDir, id)).length > 0; } catch { /* không có webapp */ }
  try { hasCs = fs.readdirSync(gw).some((f) => f.endsWith('.cs')); } catch { /* không có gateway */ }
  return { webapp: hasFiles, gateway: fs.existsSync(path.join(gw, 'ui.json')) || hasCs };
}

/** Các thư mục giải pháp có sẵn trên đĩa (có dấu nhận diện + ít nhất một phần): [{ folder, title, parts }]. */
export function detectFolders(shellDir) {
  let names = [];
  try { names = fs.readdirSync(solutionsRoot(shellDir)); } catch { /* chưa có thư mục solutions */ }
  return names.sort().filter((id) => ID_RE.test(id) && id !== BASIC && isMarked(shellDir, id))
    .map((folder) => { const m = readMeta(shellDir, folder); return { folder, title: m.title || folder, icon: String(m.icon || ''), themeColor: String(m.themeColor || ''), parts: partsOf(shellDir, folder) }; })
    .filter((f) => f.parts.webapp || f.parts.gateway);
}

/** Thư mục trông như giải pháp nhưng bị bỏ qua (thiếu dấu nhận diện hoặc không có webapp/gateway) — để admin biết vì sao chưa vào ô chọn. */
export function ignoredFolders(shellDir) {
  let names = [];
  try { names = fs.readdirSync(solutionsRoot(shellDir), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const ok = new Set(detectFolders(shellDir).map((f) => f.folder));
  return names.sort().filter((n) => !n.startsWith('_') && !ok.has(n) && n !== BASIC)
    .map((folder) => ({ folder, reason: !ID_RE.test(folder) ? 'tên thư mục không hợp lệ' : !isMarked(shellDir, folder) ? 'thiếu dấu nhận diện (solution.json: "kind": "plciot-solution")' : 'chưa có webapp/ hoặc gateway/ui.json' }));
}

/** Mọi mục (kể cả ẩn): các mục trong sổ + MỖI thư mục trên đĩa chưa có mục nào trỏ tới được tự thêm (id = tên thư mục) —
 *  chép thư mục mới lên server là ô chọn tự có mục, không cần admin thêm tay. */
export function registryItems(shellDir) {
  const items = (loadRegistry() || []).map((x) => ({ ...x }));
  for (const f of detectFolders(shellDir)) {
    if (items.some((x) => x.folder === f.folder || x.id === f.folder)) continue;
    items.push({ id: f.folder, title: f.title, folder: f.folder, enabled: true, auto: true });
  }
  return items;
}

/** Mục hiện trong ô chọn: 'basic' + các mục bật có PHẦN yêu cầu (part: 'webapp' cho ô chọn của người dùng, 'gateway' cho mã ghép cặp / gateway). */
export function listSolutions(shellDir, part = 'webapp') {
  const out = [{ id: BASIC, title: 'Cơ bản' }];
  const disk = new Map(detectFolders(shellDir).map((f) => [f.folder, f.parts]));
  for (const it of registryItems(shellDir)) if (it.enabled !== false && (part === 'any' ? (disk.get(it.folder)?.webapp || disk.get(it.folder)?.gateway) : disk.get(it.folder)?.[part])) out.push({ id: it.id, title: it.title });
  return out;
}

const validTitle = (t) => { const v = String(t ?? '').trim(); return v.length >= 1 && v.length <= 60 && !/[<>]/.test(v) ? v : null; };
const seeded = (shellDir) => registryItems(shellDir).map(({ auto, ...x }) => x);

/** Thêm mục vào ô chọn. */
export function addItem(shellDir, { id, title, folder }) {
  id = String(id || '').trim(); folder = String(folder || id).trim();
  if (!ID_RE.test(id) || id === BASIC) return { error: 'invalid_id', status: 400 };
  if (!ID_RE.test(folder) || !detectFolders(shellDir).some((f) => f.folder === folder)) return { error: 'invalid_folder', status: 400 };
  const t = validTitle(title ?? id); if (!t) return { error: 'invalid_title', status: 400 };
  const items = seeded(shellDir);
  if (items.some((x) => x.id === id)) return { error: 'exists', status: 409 };
  items.push({ id, title: t, folder, enabled: true });
  saveRegistry(items);
  return { ok: true, item: { id, title: t, folder, enabled: true } };
}

/** Sửa tên / thư mục / ẩn-hiện của mục. */
export function updateItem(shellDir, id, patch = {}) {
  const items = seeded(shellDir); const it = items.find((x) => x.id === id);
  if (!it) return { error: 'not_found', status: 404 };
  if (patch.title !== undefined) { const t = validTitle(patch.title); if (!t) return { error: 'invalid_title', status: 400 }; it.title = t; }
  if (patch.folder !== undefined) {
    const f = String(patch.folder).trim();
    if (!ID_RE.test(f) || !detectFolders(shellDir).some((x) => x.folder === f)) return { error: 'invalid_folder', status: 400 };
    it.folder = f;
  }
  if (patch.enabled !== undefined) it.enabled = !!patch.enabled;
  saveRegistry(items);
  return { ok: true, item: it };
}

/** Xoá mục; `inUse` (số user đang dùng) > 0 thì từ chối. Mục mang tên chính thư mục còn trên đĩa thì chỉ ẨN (nếu xoá hẳn, thư mục sẽ tự hiện lại). */
export function removeItem(shellDir, id, inUse = 0) {
  const items = seeded(shellDir);
  if (!items.some((x) => x.id === id)) return { error: 'not_found', status: 404 };
  if (inUse > 0) return { error: 'in_use', status: 409, users: inUse };
  const it = items.find((x) => x.id === id);
  if (it.id === it.folder && detectFolders(shellDir).some((f) => f.folder === it.folder)) { it.enabled = false; saveRegistry(items); return { ok: true, hidden: true }; }
  saveRegistry(items.filter((x) => x.id !== id));
  return { ok: true };
}

export function defaultSolution() {
  const d = String(process.env.DEFAULT_SOLUTION || BASIC).trim();
  return ID_RE.test(d) || d === BASIC ? d : BASIC;
}

/** Id mục → thư mục thực (basic nếu lạ/mất thư mục). */
export function folderOf(shellDir, id, part = 'webapp') {
  if (id === BASIC || !ID_RE.test(id)) return BASIC;
  const it = registryItems(shellDir).find((x) => x.id === id);
  return it && isMarked(shellDir, it.folder) && partsOf(shellDir, it.folder)[part] ? it.folder : BASIC;
}

/** Thư mục giải pháp hiệu lực của user (id lạ hoặc thư mục mất → 'basic', không bao giờ làm hỏng tải trang). */
export function solutionOf(shellDir, user) {
  return folderOf(shellDir, String(user?.solution || '').trim() || defaultSolution());
}

/** Mã giải pháp → { title, icon, themeColor } (icon: mã trong bộ icon chung tools/solution-kit/icons.json) để admin hiện đúng nhận diện từng giải pháp. */
export function solutionMeta(shellDir) {
  const folders = new Map(detectFolders(shellDir).map((f) => [f.folder, f]));
  const out = new Map([[BASIC, { title: 'Cơ bản', icon: 'grid', themeColor: '' }]]);
  for (const it of registryItems(shellDir)) { const f = folders.get(it.folder); out.set(it.id, { title: it.title, icon: f?.icon || '', themeColor: f?.themeColor || '' }); }
  return out;
}

export const isKnownSolution = (shellDir, id, part = 'webapp') => id === BASIC || listSolutions(shellDir, part).some((s) => s.id === id);

function readMeta(shellDir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(solutionDir(shellDir, id), 'solution.json'), 'utf8')); } catch { return {}; }
}

function injectIndex(html, meta) {
  const inj = meta.inject || {};
  const css = (inj.css || []).map((f) => `<link rel="stylesheet" href="${f}">`).join('\n');
  const js = (inj.js || []).map((f) => `<script src="${f}"></script>`).join('\n');
  let out = html;
  if (meta.title) out = out.replace(/<title>[^<]*<\/title>/, `<title>${meta.title}</title>`).replace(/(apple-mobile-web-app-title" content=")[^"]*/, `$1${meta.title}`);
  if (meta.themeColor) out = out.replace(/(name="theme-color" content=")[^"]*/, `$1${meta.themeColor}`);
  if (css) out = out.replace('</head>', `${css}\n</head>`);
  if (js) out = out.replace(/<\/body>/, `${js}\n</body>`);
  return out;
}

/** Danh sách file đã chồng lớp phủ: [{ path, read() }] — shell thường (basic) trả đúng file của shell. */
function composed(shellDir, id) {
  const map = new Map();
  if (id === BASIC) {
    for (const f of listBundleFiles(shellDir)) map.set(f.path, path.join(shellDir, f.path));
    return { files: map, meta: {} };
  }
  const meta = readMeta(shellDir, id);
  if (meta.mode !== 'full') for (const f of listBundleFiles(shellDir)) map.set(f.path, path.join(shellDir, f.path));
  const od = overlayDir(shellDir, id);
  for (const f of listBundleFiles(od)) if (!SKIP.has(path.basename(f.path).toLowerCase())) map.set(f.path, path.join(od, f.path));
  return { files: map, meta };
}

function content(p, entry, meta, id) {
  const buf = fs.readFileSync(entry);
  return id !== BASIC && p === 'index.html' ? Buffer.from(injectIndex(buf.toString('utf8'), meta)) : buf;
}

/** Phiên bản của giải pháp: basic giữ nguyên công thức cũ (user hiện có không bị đồng bộ lại). */
export function solutionVersion(shellDir, id) {
  if (id === BASIC) return shellVersion(shellDir);
  const { files, meta } = composed(shellDir, id);
  const h = crypto.createHash('sha256');
  for (const p of [...files.keys()].sort((a, b) => a.localeCompare(b))) {
    h.update(`${p}:${crypto.createHash('sha256').update(content(p, files.get(p), meta, id)).digest('hex').slice(0, 16)}\n`);
  }
  return h.digest('hex').slice(0, 12);
}

/** Ghi bản webapp của giải pháp vào thư mục bundle của user (xoá file thừa của bản cũ). */
export function writeSolution(shellDir, id, root) {
  if (id === BASIC) {
    copyDir(shellDir, root);
    const keep = new Set(listBundleFiles(shellDir).map((f) => f.path));
    for (const f of listBundleFiles(root)) if (!keep.has(f.path)) fs.unlinkSync(path.join(root, f.path));
    return;
  }
  const { files, meta } = composed(shellDir, id);
  fs.mkdirSync(root, { recursive: true });
  for (const [p, entry] of files) {
    const dest = path.join(root, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content(p, entry, meta, id));
  }
  for (const f of listBundleFiles(root)) if (!files.has(f.path)) fs.unlinkSync(path.join(root, f.path));
}

/* ---------- Bundle webapp của user = shell + MỌI giải pháp của các gateway user đang dùng ----------
 * Loại webapp do GATEWAY quyết định (gateway_solutions), không theo user. User có nhiều gateway khác kiểu → bundle chứa
 * shell + overlay từng giải pháp đặt dưới sol/<id>/ + solutions.json (bản khai); webapp (sol-multi.js) nạp giao diện
 * của giải pháp tương ứng khi người dùng chọn tab gateway. Không có giải pháp nào → đúng bản shell cơ bản (version cũ). */
export function userBundlePlan(shellDir, ids = []) {
  const files = new Map();   // path → { abs, hash }
  for (const f of listBundleFiles(shellDir)) files.set(f.path, { abs: path.join(shellDir, f.path), hash: f.hash });
  const manifest = {};
  for (const id of [...new Set(ids)].sort()) {
    const folder = folderOf(shellDir, id);
    if (folder === BASIC) continue;
    const meta = readMeta(shellDir, folder), od = overlayDir(shellDir, folder), pre = `sol/${id}/`;
    for (const f of listBundleFiles(od)) if (!SKIP.has(path.basename(f.path).toLowerCase())) files.set(pre + f.path, { abs: path.join(od, f.path), hash: f.hash });
    const inj = meta.inject || {};
    manifest[id] = { title: meta.title || id, themeColor: meta.themeColor || '', css: (inj.css || []).map((x) => pre + x), js: (inj.js || []).map((x) => pre + x) };
  }
  const has = Object.keys(manifest).length > 0;
  return { files, manifest: has ? manifest : null };
}

export function userBundleVersion(shellDir, ids = []) {
  const { files, manifest } = userBundlePlan(shellDir, ids);
  if (!manifest) return shellVersion(shellDir);
  const h = crypto.createHash('sha256');
  for (const p of [...files.keys()].sort((a, b) => a.localeCompare(b))) h.update(`${p}:${files.get(p).hash}\n`);
  h.update(JSON.stringify(manifest));
  return h.digest('hex').slice(0, 12);
}

export function writeUserBundle(shellDir, ids, root) {
  const { files, manifest } = userBundlePlan(shellDir, ids);
  fs.mkdirSync(root, { recursive: true });
  const keep = new Set(files.keys());
  for (const [p, f] of files) {
    const dest = path.join(root, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  if (manifest) { fs.writeFileSync(path.join(root, 'solutions.json'), JSON.stringify(manifest)); keep.add('solutions.json'); }
  for (const f of listBundleFiles(root)) if (!keep.has(f.path)) fs.unlinkSync(path.join(root, f.path));
}
