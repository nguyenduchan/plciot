#!/usr/bin/env node
/**
 * Xuất / đối chiếu / dựng lược đồ PostgreSQL từ file SQLite — để sau này chuyển sang PostgreSQL mà KHÔNG mất dữ liệu.
 *
 *   node scripts/db-export.js export    --db data/app.db --out ./export [--tables a,b]   # CSV từng bảng + manifest.json (đếm dòng, sha256)
 *   node scripts/db-export.js verify    --db data/app.db --export ./export                # xuất lại và so từng bảng với manifest
 *   node scripts/db-export.js pg-schema --export ./export [--out ./export]                # schema.pg.sql + import.psql
 *
 * An toàn: chỉ ĐỌC. Bản chụp nhất quán qua API backup của SQLite (không khoá app đang ghi, không đọc dở giao dịch WAL).
 * CSV: chuỗi luôn trong dấu nháy kép, NULL = \N (không nháy), BLOB = "\x<hex>" — nạp thẳng bằng
 *   \copy <bảng> FROM '<bảng>.csv' WITH (FORMAT csv, HEADER true, NULL '\N')
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const MANIFEST_VERSION = 1;
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

function cell(v) {
  if (v === null || v === undefined) return '\\N';
  if (Buffer.isBuffer(v)) return `"\\x${v.toString('hex')}"`;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return `"${String(v).replace(/"/g, '""')}"`;
}

/** Bản chụp nhất quán để đọc (API backup), trả về { db, cleanup }. */
async function snapshot(dbPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-'));
  const copy = path.join(tmp, 'snap.db');
  const src = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { await src.backup(copy); } finally { src.close(); }
  const db = new Database(copy, { readonly: true });
  db.defaultSafeIntegers(false);
  return { db, cleanup: () => { try { db.close(); } catch { /* bỏ qua */ } fs.rmSync(tmp, { recursive: true, force: true }); } };
}

export function listTables(db, only = null) {
  const all = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return only?.length ? all.filter((t) => only.includes(t.name)) : all;
}

/** Ghi CSV một bảng (theo thứ tự rowid/khoá chính để băm ổn định); trả về { rows, sha256, columns }. */
export function dumpTable(db, table, file) {
  const cols = db.prepare(`PRAGMA table_info(${q(table)})`).all();
  const names = cols.map((c) => c.name);
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  const order = pk.length ? pk.map(q).join(', ') : 'rowid';
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'w');
  let rows = 0;
  let buf = [];
  const flush = () => { if (buf.length) { const s = buf.join(''); hash.update(s); fs.writeSync(fd, s); buf = []; } };
  const push = (line) => { buf.push(line); if (buf.length >= 2000) flush(); };
  push(names.map((n) => `"${n.replace(/"/g, '""')}"`).join(',') + '\n');
  for (const r of db.prepare(`SELECT ${names.map(q).join(', ')} FROM ${q(table)} ORDER BY ${order}`).iterate()) {
    push(names.map((n) => cell(r[n])).join(',') + '\n');
    rows += 1;
  }
  flush();
  fs.closeSync(fd);
  return {
    rows, sha256: hash.digest('hex'),
    columns: cols.map((c) => ({ name: c.name, type: String(c.type || '').toUpperCase(), notnull: !!c.notnull, pk: c.pk | 0, dflt: c.dflt_value })),
  };
}

export async function exportDb({ dbPath, outDir, tables = null }) {
  const { db, cleanup } = await snapshot(dbPath);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const manifest = {
      version: MANIFEST_VERSION, exportedAt: new Date().toISOString(), source: path.basename(dbPath),
      sqlite: db.prepare('select sqlite_version() v').get().v, tables: {}, indexes: [],
    };
    for (const t of listTables(db, tables)) {
      manifest.tables[t.name] = { ...dumpTable(db, t.name, path.join(outDir, `${t.name}.csv`)), createSql: t.sql };
    }
    manifest.indexes = db.prepare("SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all();
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally { cleanup(); }
}

/** Xuất lại DB vào thư mục tạm rồi so từng bảng (số dòng + sha256) với manifest. Trả về { ok, diffs[] }. */
export async function verifyDb({ dbPath, exportDir }) {
  const m = JSON.parse(fs.readFileSync(path.join(exportDir, 'manifest.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbv-'));
  try {
    const now = await exportDb({ dbPath, outDir: tmp, tables: Object.keys(m.tables) });
    const diffs = [];
    for (const [name, exp] of Object.entries(m.tables)) {
      const cur = now.tables[name];
      if (!cur) { diffs.push(`${name}: bảng không còn`); continue; }
      if (cur.rows !== exp.rows) diffs.push(`${name}: số dòng ${cur.rows} ≠ ${exp.rows}`);
      else if (cur.sha256 !== exp.sha256) diffs.push(`${name}: nội dung khác (cùng ${exp.rows} dòng)`);
      // kiểm thêm file CSV đã xuất còn nguyên (không bị sửa/cắt sau khi xuất)
      const f = path.join(exportDir, `${name}.csv`);
      if (!fs.existsSync(f)) diffs.push(`${name}: thiếu ${name}.csv`);
      else if (crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') !== exp.sha256) diffs.push(`${name}: ${name}.csv đã bị thay đổi sau khi xuất`);
    }
    return { ok: diffs.length === 0, diffs };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const PG_TYPE = (t, pk, single) => {
  const u = (t || '').toUpperCase();
  if (pk && single && /INT/.test(u)) return 'BIGINT GENERATED BY DEFAULT AS IDENTITY';
  if (/INT/.test(u)) return 'BIGINT';
  if (/CHAR|CLOB|TEXT/.test(u)) return 'TEXT';
  if (/BLOB/.test(u)) return 'BYTEA';
  if (/REAL|FLOA|DOUB/.test(u)) return 'DOUBLE PRECISION';
  if (/NUM|DEC/.test(u)) return 'NUMERIC';
  if (/BOOL/.test(u)) return 'BOOLEAN';
  return 'TEXT';
};

/** Dựng schema.pg.sql + import.psql từ manifest. Chỗ cần người xem lại được ghi chú bằng `-- XEM LẠI`. */
export function pgSchema({ exportDir, outDir = exportDir }) {
  const m = JSON.parse(fs.readFileSync(path.join(exportDir, 'manifest.json'), 'utf8'));
  const ddl = ['-- Sinh bởi scripts/db-export.js pg-schema; kiểm lại các dòng XEM LẠI trước khi chạy', 'BEGIN;'];
  const imp = ['\\set ON_ERROR_STOP on', '\\echo Nạp dữ liệu từ CSV (chạy từ thư mục chứa các file .csv)', 'BEGIN;'];
  const post = [];
  for (const [name, t] of Object.entries(m.tables)) {
    const pks = t.columns.filter((c) => c.pk > 0);
    const single = pks.length === 1;
    const cols = t.columns.map((c) => {
      let d = `  "${c.name}" ${PG_TYPE(c.type, c.pk > 0, single)}`;
      let note = '';
      if (c.notnull && !(c.pk > 0 && single)) d += ' NOT NULL';
      if (c.dflt != null && !/^\(?\s*(strftime|datetime|date|time|julianday)/i.test(String(c.dflt)) && /^('.*'|-?\d+(\.\d+)?)$/.test(String(c.dflt).trim())) d += ` DEFAULT ${c.dflt}`;
      else if (c.dflt != null) note = `-- XEM LẠI: mặc định SQLite ${String(c.dflt).replace(/\s+/g, ' ')}`;
      return { d, note };
    });
    if (pks.length > 1) cols.push({ d: `  PRIMARY KEY (${pks.sort((a, b) => a.pk - b.pk).map((c) => `"${c.name}"`).join(', ')})`, note: '' });
    else if (single) cols.push({ d: `  PRIMARY KEY ("${pks[0].name}")`, note: '' });
    // dấu phẩy phải đứng TRƯỚC chú thích, nếu không chú thích nuốt mất dấu phẩy
    const body = cols.map((x, i) => `${x.d}${i < cols.length - 1 ? ',' : ''}${x.note ? `   ${x.note}` : ''}`).join('\n');
    ddl.push(`CREATE TABLE "${name}" (\n${body}\n);`);
    imp.push(`\\copy "${name}" (${t.columns.map((c) => `"${c.name}"`).join(', ')}) FROM '${name}.csv' WITH (FORMAT csv, HEADER true, NULL '\\N')`);
    if (single && /INT/.test(pks[0].type)) {
      post.push(`SELECT setval(pg_get_serial_sequence('"${name}"', '${pks[0].name}'), COALESCE((SELECT MAX("${pks[0].name}") FROM "${name}"), 0) + 1, false);`);
    }
  }
  for (const ix of m.indexes) {
    if (!m.tables[ix.tbl]) continue;
    const warn = /COLLATE\s+NOCASE|WHERE|\|\|/i.test(ix.sql) ? '   -- XEM LẠI: cú pháp riêng của SQLite' : '';
    ddl.push(`${ix.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i, (_s, u) => `CREATE ${u || ''}INDEX`)};${warn}`);
  }
  ddl.push('COMMIT;');
  imp.push(...post, 'COMMIT;');
  imp.push('\\echo Đối chiếu số dòng với manifest.json:');
  for (const [name, t] of Object.entries(m.tables)) imp.push(`SELECT '${name}' AS bang, count(*) AS dong, ${t.rows} AS ky_vong, (count(*) = ${t.rows}) AS khop FROM "${name}";`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'schema.pg.sql'), ddl.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'import.psql'), imp.join('\n') + '\n');
  return { tables: Object.keys(m.tables).length };
}

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };

async function main() {
  const cmd = process.argv[2];
  const dbPath = path.resolve(arg('db', process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'app.db') : 'data/app.db'));
  const dir = path.resolve(arg('out', arg('export', './export')));
  if (cmd === 'export') {
    const tables = arg('tables') ? arg('tables').split(',') : null;
    const m = await exportDb({ dbPath, outDir: dir, tables });
    const rows = Object.values(m.tables).reduce((s, t) => s + t.rows, 0);
    console.log(`Đã xuất ${Object.keys(m.tables).length} bảng, ${rows} dòng → ${dir}`);
  } else if (cmd === 'verify') {
    const r = await verifyDb({ dbPath, exportDir: path.resolve(arg('export', './export')) });
    if (r.ok) console.log('KHỚP: mọi bảng giống bản xuất.');
    else { console.error('KHÁC:\n- ' + r.diffs.join('\n- ')); process.exit(1); }
  } else if (cmd === 'pg-schema') {
    const r = pgSchema({ exportDir: path.resolve(arg('export', './export')), outDir: dir });
    console.log(`Đã sinh schema.pg.sql + import.psql cho ${r.tables} bảng → ${dir}`);
  } else {
    console.error('Dùng: export | verify | pg-schema  (xem đầu file)');
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e.message); process.exit(1); });
