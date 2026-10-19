'use strict';
/* Time-series store living in the browser (IndexedDB), managed entirely by the app.
   Three retention tiers; finer data is folded into coarser buckets and then expired:
     raw   every ~10 s   kept 24 h
     min   1 minute      kept 30 days
     hour  1 hour        kept 2 years
   Nothing leaves the device unless the user exports a backup. */
const DB = (() => {
  const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
  const KEEP = { raw: DAY, min: 30 * DAY, hour: 730 * DAY };
  const TIER_MS = { raw: 10e3, min: MIN, hour: HOUR };
  let db = null, ok = false, name = '';

  const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
  const store = (n, m = 'readonly') => db.transaction(n, m).objectStore(n);

  async function open(dbName) {
    if (db) { db.close(); db = null; }
    ok = false; name = dbName;
    if (!window.indexedDB) return false;
    try {
      db = await new Promise((res, rej) => {
        const r = indexedDB.open('plc-' + dbName, 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          Object.keys(KEEP).forEach((s) => d.createObjectStore(s, { keyPath: 't' }));
          d.createObjectStore('kv');
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
      });
      ok = true;
    } catch { ok = false; }
    return ok;
  }

  const kvGet = (k) => ok ? wrap(store('kv').get(k)) : Promise.resolve(undefined);
  const kvSet = (k, v) => ok ? wrap(store('kv', 'readwrite').put(v, k)) : Promise.resolve();
  const range = (s, a, b) => ok ? wrap(store(s).getAll(IDBKeyRange.bound(a, b))) : Promise.resolve([]);
  async function putMany(s, recs) {
    if (!ok || !recs.length) return;
    const tx = db.transaction(s, 'readwrite'), st = tx.objectStore(s);
    recs.forEach((r) => st.put(r));
    await done(tx);
  }
  const addRaw = (rec) => ok ? putMany('raw', [rec]).catch(() => {}) : null;

  /* raw {t,o,i,a,c,s} -> common shape {t,n,c1,run,ou[8],al} */
  const fromRaw = (r) => ({ t: r.t, n: 1, c1: r.c, run: r.s === 1 ? 1 : 0, ou: Array.from({ length: 8 }, (_, i) => (r.o >> i & 1) * 100), al: r.a, o: r.o, i: r.i });

  /* fold records of one bucket (already in the common shape) into a single record */
  function fold(t, rows) {
    const n = rows.reduce((a, r) => a + r.n, 0), ou = new Array(8).fill(0);
    let run = 0, al = 0;
    rows.forEach((r) => { run += r.run * r.n; al |= r.al; for (let i = 0; i < 8; i++) ou[i] += r.ou[i] * r.n; });
    return { t, n, c1: rows[rows.length - 1].c1, run: run / n, ou: ou.map((x) => Math.round(x / n)), al };
  }

  /* fold `from` tier into `to` tier for every complete bucket not yet processed */
  async function rollup(from, to, size, norm, tag) {
    const last = (await kvGet('last_' + tag)) || 0, end = Math.floor(Date.now() / size) * size;
    if (end <= last) return;
    const rows = (await range(from, last, end - 1)).map(norm), groups = new Map();
    rows.forEach((r) => { const k = Math.floor(r.t / size) * size; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    let prevC = await kvGet('lastc_' + tag);
    const out = [];
    [...groups.keys()].sort((a, b) => a - b).forEach((k) => {
      const f = fold(k, groups.get(k)), first = groups.get(k)[0].c1;
      f.d = Math.max(0, f.c1 - (prevC ?? first)); prevC = f.c1; out.push(f);
    });
    await putMany(to, out);
    await kvSet('lastc_' + tag, prevC); await kvSet('last_' + tag, end);
  }

  async function compact() {
    if (!ok) return;
    try {
      await rollup('raw', 'min', MIN, fromRaw, 'min');
      await rollup('min', 'hour', HOUR, (r) => r, 'hour');
      const now = Date.now();
      for (const s of Object.keys(KEEP)) {
        const tx = db.transaction(s, 'readwrite');
        tx.objectStore(s).delete(IDBKeyRange.upperBound(now - KEEP[s]));
        await done(tx);
      }
    } catch (e) { console.warn('compact:', e && e.message); }  // storage full or closed: retry next minute
  }

  /* Rows between from..to at a suitable resolution, in the common shape plus d = products in that step. */
  async function series(from, to) {
    const span = to - from, now = Date.now();
    let tier = span <= 6 * HOUR && from >= now - KEEP.raw ? 'raw' : span <= 30 * DAY && from >= now - KEEP.min ? 'min' : 'hour';
    let rows = await range(tier, from, to);
    if (tier === 'raw') {
      let prev = null;
      rows = rows.map(fromRaw).map((r) => { r.d = prev == null ? 0 : Math.max(0, r.c1 - prev); prev = r.c1; return r; });
    }
    return { rows, tier, ms: TIER_MS[tier] };
  }

  async function stats() {
    const o = { name, ok };
    for (const s of Object.keys(KEEP)) o[s] = ok ? await wrap(store(s).count()) : 0;
    try { const e = await navigator.storage.estimate(); o.usage = e.usage; o.quota = e.quota; } catch {}
    return o;
  }
  async function exportAll() {
    const o = { v: 1, db: name, at: Date.now() };
    for (const s of Object.keys(KEEP)) o[s] = ok ? await wrap(store(s).getAll()) : [];
    return o;
  }
  async function importAll(o) {
    if (!o || o.v !== 1) throw new Error('Tệp sao lưu không hợp lệ');
    let n = 0;
    for (const s of Object.keys(KEEP)) { const recs = Array.isArray(o[s]) ? o[s].filter((r) => r && Number.isFinite(r.t)) : []; await putMany(s, recs); n += recs.length; }
    return n;
  }
  async function clearAll() {
    if (!ok) return;
    for (const s of [...Object.keys(KEEP), 'kv']) { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).clear(); await done(tx); }
  }
  async function persist() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch { return null; }
  }

  return { open, addRaw, putMany, compact, series, stats, exportAll, importAll, clearAll, persist, range, get ok() { return ok; }, KEEP };
})();
