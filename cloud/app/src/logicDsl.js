/**
 * CHƯƠNG TRÌNH LOGIC CỦA GATEWAY dạng TEXT (cho admin, GatewayAdmin) ⇄ JSON (/offline.json của board) ⇄ BẢNG tiếng Việt (chủ trạm duyệt).
 * Một chương trình / gateway. Mỗi dòng một DO, các mệnh đề cách nhau bằng "|", "#" = chú thích. Ví dụ:
 *
 *   tz 7
 *   do1: need di3=1, hold | block do2 | maxon 30m | offline 2m: level bon.muc on<=20 off>=90 age 60s
 *   do2: block do1 | offline 1m: off
 *   do3: timer 18:00-05:30 t2-t6 | offline 5m: schedule 18:00-05:30
 *   do4: need chuong.nhiet>=5 | offline: level chuong.nhiet on>=32 off<=29
 *   do5: offline: follow di2 invert
 *   do6: offline: cycle on 10m off 20m
 *
 * Mệnh đề (thứ tự tuỳ ý, một DO có thể viết trên nhiều dòng — gộp lại):
 *   need <đk>[, <đk>…][, hold]   chỉ cho BẬT khi mọi điều kiện thoả; hold = đang bật mà mất điều kiện thì tự tắt.
 *                                <đk>: di3=1 | di3=0 | <thiết bị>.<field> >= số | <= số  [age 60s]  (mất số liệu = không thoả)
 *   block do2[, do5]             liên động: không bật khi DO kia đang bật (hai chiều)
 *   maxon 30m                    bật liên tục quá lâu thì tự tắt
 *   timer 06:00-06:30 [ngày]     hẹn giờ (theo sự kiện): bật lúc 06:00, tắt lúc 06:30 · timer on 06:00 · timer off 22:00
 *                                ngày: t2-t6 | t2,t4,cn | t7-cn (mặc định mọi ngày) — chủ trạm cũng tự sửa được trên webapp
 *   offline [chờ]: <kiểu>        khi mất mạng (sau thời gian chờ, mặc định 60s): hold | off | on | schedule 18:00-05:30
 *                                | follow di2 [invert] | level <field> on<=20 off>=90 [age 30s] | cycle on 10m off 20m
 * Thời gian: 30s, 5m, 2h, 1d hoặc số giây.
 * Board vẫn kiểm lại toàn bộ (field có thật không…) khi áp dụng — server chỉ kiểm cú pháp và giới hạn.
 *
 * GATEWAY PC (C#, Plciot.Scada.Core/GatewayLogic.cs): đầu ra là FIELD ghi được thay cho doN, không có DI của board:
 *   pump1.run: need tank1.level_pct>=10, hold | block pump1.boost | maxon 30m | timer 06:00-06:30 | offline 2m: level tank1.level_pct on<=20 off>=90
 *   valve1.open: offline: follow pump1.run            (follow <field> [invert] — bật khi field ≠ 0)
 * JSON: {Out:"<thiết bị>.<field>", …, Block:["<thiết bị>.<field>"]}. "<field>=1" / "=0" là cách viết gọn của ">=1" / "<=0".
 */

const DAY = ['t2', 't3', 't4', 't5', 't6', 't7', 'cn'];

export class LogicError extends Error {}

const fail = (line, msg) => { throw new LogicError(line ? `Dòng ${line}: ${msg}` : msg); };

export function parseDuration(s, line) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/i.exec(String(s).trim());
  if (!m) fail(line, `thời gian "${s}" không hợp lệ (vd 30s, 5m, 2h).`);
  const k = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || 's').toLowerCase()];
  return Math.round(Number(m[1]) * k);
}

const hhmm = (s, line) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) fail(line, `giờ "${s}" phải dạng HH:MM.`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
};

function parseDays(s, line) {
  const out = new Set();
  for (const part of String(s).toLowerCase().split(',').map((x) => x.trim()).filter(Boolean)) {
    const [a, b] = part.split('-');
    const ia = DAY.indexOf(a), ib = b === undefined ? ia : DAY.indexOf(b);
    if (ia < 0 || ib < 0) fail(line, `ngày "${part}" không hợp lệ (t2…t7, cn; vd t2-t6).`);
    for (let i = ia; ; i = (i + 1) % 7) { out.add(i + 1); if (i === ib) break; }
  }
  return [...out].sort((x, y) => x - y);
}

const FIELD = /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/;

function parseCond(s, line) {
  let m = /^di([1-8])\s*=\s*([01])$/i.exec(s);
  if (m) return { Di: Number(m[1]), Is: Number(m[2]) };
  m = /^(\S+?)\s*=\s*([01])(?:\s+age\s+(\S+))?$/i.exec(s);   // field=1 / field=0 (tín hiệu số) = >=1 / <=0
  if (m && FIELD.test(m[1])) {
    const c = { Field: m[1], Op: m[2] === '1' ? '>=' : '<=', Val: Number(m[2]) };
    if (m[3]) c.MaxAgeSec = parseDuration(m[3], line);
    return c;
  }
  m = /^(\S+?)\s*(>=|<=)\s*(-?\d+(?:\.\d+)?)(?:\s+age\s+(\S+))?$/i.exec(s);
  if (!m) fail(line, `điều kiện "${s}" không hợp lệ (vd di3=1, bon.muc>=20).`);
  if (!FIELD.test(m[1])) fail(line, `"${m[1]}" phải dạng <thiết bị>.<field>.`);
  const c = { Field: m[1], Op: m[2], Val: Number(m[3]) };
  if (m[4]) c.MaxAgeSec = parseDuration(m[4], line);
  return c;
}

function parseOffline(spec, line, o) {
  const t = spec.trim().split(/\s+/);
  const mode = (t[0] || '').toLowerCase();
  o.Mode = mode;
  switch (mode) {
    case 'hold': case 'off': case 'on': if (t.length > 1) fail(line, `"${mode}" không có tham số.`); break;
    case 'schedule': {
      const m = /^(\S+)-(\S+)$/.exec(t[1] || '');
      if (!m || t.length > 2) fail(line, 'schedule cần dạng schedule 18:00-05:30.');
      o.From = hhmm(m[1], line); o.To = hhmm(m[2], line);
      if (o.From === o.To) fail(line, 'schedule: giờ bật và giờ tắt phải khác nhau.');
      break;
    }
    case 'follow': {
      const m = /^di([1-8])$/i.exec(t[1] || '');
      if ((!m && !FIELD.test(t[1] || '')) || t.length > 3 || (t[2] && t[2].toLowerCase() !== 'invert')) fail(line, 'follow cần dạng follow di2 [invert] (board) hoặc follow <thiết bị>.<field> [invert].');
      if (m) o.Di = Number(m[1]); else o.Field = t[1];
      o.Invert = Boolean(t[2]);
      break;
    }
    case 'level': {
      const rest = t.slice(1).join(' ');
      const m = /^(\S+)\s+on\s*(<=|>=)\s*(-?\d+(?:\.\d+)?)\s+off\s*(<=|>=)\s*(-?\d+(?:\.\d+)?)(?:\s+age\s+(\S+))?$/i.exec(rest);
      if (!m) fail(line, 'level cần dạng level bon.muc on<=20 off>=90 [age 30s].');
      if (!FIELD.test(m[1])) fail(line, `"${m[1]}" phải dạng <thiết bị>.<field>.`);
      const on = Number(m[3]), off = Number(m[5]);
      if (m[2] === m[4]) fail(line, 'level: ngưỡng bật và tắt phải ngược chiều (on<=… off>=… hoặc on>=… off<=…).');
      if (m[2] === '<=' ? on >= off : on <= off) fail(line, 'level: ngưỡng bật/tắt mâu thuẫn (cần khoảng trễ giữa hai ngưỡng).');
      o.Field = m[1]; o.On = on; o.Off = off;
      if (m[6]) o.MaxAgeSec = parseDuration(m[6], line);
      break;
    }
    case 'cycle': {
      const m = /^on\s+(\S+)\s+off\s+(\S+)$/i.exec(t.slice(1).join(' '));
      if (!m) fail(line, 'cycle cần dạng cycle on 10m off 20m.');
      o.OnSec = parseDuration(m[1], line); o.OffSec = parseDuration(m[2], line);
      if (o.OnSec < 1 || o.OffSec < 1 || o.OnSec > 86400 || o.OffSec > 86400) fail(line, 'cycle: thời gian từ 1 giây đến 24 giờ.');
      break;
    }
    default: fail(line, `kiểu khi mất mạng "${mode}" không có (hold, off, on, schedule, follow, level, cycle).`);
  }
  if (mode === 'level') o.Mode = 'threshold';
}

function parseTimer(spec, line) {
  const t = spec.trim().split(/\s+/);
  const e = {};
  let i = 0;
  if (/^on$/i.test(t[0])) { e.On = hhmm(t[1], line); i = 2; }
  else if (/^off$/i.test(t[0])) { e.Off = hhmm(t[1], line); i = 2; }
  else {
    const m = /^(\S+)-(\S+)$/.exec(t[0] || '');
    if (!m) fail(line, 'timer cần dạng timer 06:00-06:30 [t2-t6] | timer on 06:00 | timer off 22:00.');
    e.On = hhmm(m[1], line); e.Off = hhmm(m[2], line); i = 1;
    if (e.On === e.Off) fail(line, 'timer: giờ bật và giờ tắt phải khác nhau.');
  }
  if (t[i]) e.Days = parseDays(t.slice(i).join(''), line);
  if (e.Days && e.Days.length === 7) delete e.Days;
  return e;
}

/** id của một mục: số DO (board) hoặc tên field đầu ra (gateway PC). */
export const idOf = (o) => (o?.Out ? String(o.Out) : String(o?.Ch));

/**
 * Text → {TzMin, Do:[…]} (đúng định dạng PUT /api/offline). Ném LogicError với câu báo tiếng Việt.
 * kind: 'mcu' (board: doN, di) | 'pc' (gateway C#: đầu ra là field) | undefined (không kiểm loại).
 */
export function parseLogic(text, { kind } = {}) {
  const prog = { TzMin: 420, Do: [] };
  const byCh = new Map();
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  if (lines.length > 200) fail(0, 'Chương trình quá dài.');
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    const s = raw.replace(/#.*/, '').trim();
    if (!s) return;
    let m = /^tz\s+([+-]?\d+(?:\.\d+)?)$/i.exec(s);
    if (m) { const tz = Math.round(Number(m[1]) * 60); if (tz < -720 || tz > 840) fail(line, 'múi giờ phải từ -12 đến +14.'); prog.TzMin = tz; return; }
    m = /^(?:do([1-8])|([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+))\s*:\s*(.*)$/i.exec(s);
    if (!m) fail(line, kind === 'pc' ? 'mỗi dòng bắt đầu bằng <thiết bị>.<field>: (vd pump1.run: need tank1.level_pct>=10) hoặc tz 7.' : 'mỗi dòng bắt đầu bằng doN: (vd do1: need di3=1) hoặc tz 7.');
    const isPc = Boolean(m[2]);
    if (kind === 'mcu' && isPc) fail(line, 'board Waveshare: đầu ra viết doN (do1…do8).');
    if (kind === 'pc' && !isPc) fail(line, 'gateway PC: đầu ra viết theo field ghi được (vd pump1.run:), không có doN.');
    const ch = isPc ? m[2] : Number(m[1]);
    const o = byCh.get(String(ch)) || (isPc ? { Out: ch } : { Ch: ch });
    byCh.set(String(ch), o);
    const tag = isPc ? ch : `do${ch}`;
    for (const clauseRaw of m[3].split('|')) {
      const c = clauseRaw.trim();
      if (!c) continue;
      const kw = c.split(/[\s:]/)[0].toLowerCase();
      const rest = c.slice(kw.length).trim();
      if (kw === 'need') {
        const parts = rest.split(',').map((x) => x.trim()).filter(Boolean);
        o.Need = o.Need || [];
        for (const p of parts) {
          if (/^hold$/i.test(p)) { o.NeedHold = true; continue; }
          const c = parseCond(p, line);
          if (isPc && c.Di) fail(line, 'gateway PC không có DI của board — dùng field (vd pump1.float=1).');
          o.Need.push(c);
        }
        if (o.Need.length > 4) fail(line, `${tag}: tối đa 4 điều kiện.`);
      } else if (kw === 'block') {
        o.Block = o.Block || [];
        for (const p of rest.split(',').map((x) => x.trim()).filter(Boolean)) {
          if (isPc) {
            if (!FIELD.test(p) || p === ch) fail(line, 'block cần đầu ra khác (vd block pump1.boost).');
            if (!o.Block.includes(p)) o.Block.push(p);
            continue;
          }
          const b = /^do([1-8])$/i.exec(p);
          if (!b || Number(b[1]) === ch) fail(line, `block cần DO khác (vd block do2).`);
          if (!o.Block.includes(Number(b[1]))) o.Block.push(Number(b[1]));
        }
      } else if (kw === 'maxon') {
        o.MaxOnSec = parseDuration(rest, line);
        if (o.MaxOnSec > 604800) fail(line, 'maxon tối đa 7 ngày.');
      } else if (kw === 'timer') {
        o.Timer = o.Timer || [];
        o.Timer.push(parseTimer(rest, line));
        if (o.Timer.length > 4) fail(line, `${tag}: tối đa 4 mốc hẹn giờ.`);
      } else if (kw === 'offline') {
        const om = /^([^:]*):\s*(.+)$/.exec(rest);
        if (!om) fail(line, 'offline cần dạng offline 2m: off (thời gian chờ tuỳ chọn).');
        if (o.Mode) fail(line, `${tag}: chỉ một mệnh đề offline.`);
        o.DelaySec = om[1].trim() ? parseDuration(om[1].trim(), line) : 60;
        if (o.DelaySec > 86400) fail(line, 'thời gian chờ tối đa 24 giờ.');
        parseOffline(om[2], line, o);
        if (isPc && o.Mode === 'follow' && o.Di) fail(line, 'gateway PC: follow theo field (vd follow pump1.run), không có DI.');
        if (!isPc && o.Mode === 'follow' && !o.Di) fail(line, 'board: follow theo DI (vd follow di2).');
      } else fail(line, `không hiểu "${kw}" (need, block, maxon, timer, offline).`);
    }
    if (o.NeedHold && !(o.Need || []).length) fail(line, `${tag}: hold cần ít nhất một điều kiện.`);
  });
  if (byCh.size > 32) fail(0, 'Tối đa 32 đầu ra trong một chương trình.');
  for (const o of [...byCh.values()].sort((a, b) => (a.Ch && b.Ch ? a.Ch - b.Ch : 0))) {
    if (!o.Mode) { o.Mode = 'hold'; o.DelaySec = o.DelaySec ?? 60; }
    prog.Do.push(o);
  }
  return prog;
}

const dur = (sec) => {
  sec = Number(sec) || 0;
  if (sec && sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
};
const daysText = (days) => {
  if (!days || days.length === 7) return '';
  const d = [...days].sort((a, b) => a - b);
  const runs = [];
  for (let i = 0; i < d.length;) {
    let j = i; while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
    runs.push(j > i + 1 ? `${DAY[d[i] - 1]}-${DAY[d[j] - 1]}` : d.slice(i, j + 1).map((x) => DAY[x - 1]).join(','));
    i = j + 1;
  }
  return runs.join(',');
};
const timerText = (t) => {
  const base = t.On && t.Off ? `${t.On}-${t.Off}` : t.On ? `on ${t.On}` : `off ${t.Off}`;
  const d = daysText(t.Days);
  return d ? `${base} ${d}` : base;
};

/** JSON chương trình (board/ server) → text (để admin sửa / copy sang gateway khác). */
export function formatLogic(prog) {
  const lines = [`tz ${(Number(prog?.TzMin ?? prog?.tz ?? 420) / 60)}`];
  for (const o of prog?.Do || prog?.do || []) {
    const cl = [];
    if (o.Need?.length) cl.push(`need ${o.Need.map((c) => (c.Di ? `di${c.Di}=${c.Is ?? 1}` : `${c.Field}${c.Op}${c.Val}${c.MaxAgeSec && c.MaxAgeSec !== 60 ? ` age ${dur(c.MaxAgeSec)}` : ''}`)).join(', ')}${o.NeedHold ? ', hold' : ''}`);
    if (o.Block?.length) cl.push(`block ${o.Block.map((b) => (typeof b === 'number' ? `do${b}` : b)).join(', ')}`);
    if (o.MaxOnSec) cl.push(`maxon ${dur(o.MaxOnSec)}`);
    for (const t of o.Timer || []) cl.push(`timer ${timerText(t)}`);
    const delay = o.DelaySec === undefined || o.DelaySec === 60 ? '' : ` ${dur(o.DelaySec)}`;
    switch (o.Mode) {
      case 'schedule': cl.push(`offline${delay}: schedule ${o.From}-${o.To}`); break;
      case 'follow': cl.push(`offline${delay}: follow ${o.Di ? `di${o.Di}` : o.Field}${o.Invert ? ' invert' : ''}`); break;
      case 'threshold': {
        const up = o.On > o.Off;
        cl.push(`offline${delay}: level ${o.Field} on${up ? '>=' : '<='}${o.On} off${up ? '<=' : '>='}${o.Off}${o.MaxAgeSec && o.MaxAgeSec !== 30 ? ` age ${dur(o.MaxAgeSec)}` : ''}`);
        break;
      }
      case 'cycle': cl.push(`offline${delay}: cycle on ${dur(o.OnSec)} off ${dur(o.OffSec)}`); break;
      case 'off': case 'on': cl.push(`offline${delay}: ${o.Mode}`); break;
      default: break;   // hold = mặc định
    }
    if (cl.length) lines.push(`${o.Out || `do${o.Ch}`}: ${cl.join(' | ')}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ bảng tiếng Việt cho chủ trạm
const human = (sec) => {
  sec = Number(sec) || 0;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600} giờ`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} phút`;
  return `${sec} giây`;
};
const DAYV = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const daysV = (days) => (!days || days.length === 7 ? 'mỗi ngày' : days.map((d) => DAYV[d - 1]).join(', '));
const num = (v) => String(v).replace('.', ',');

/**
 * Bảng cho chủ trạm: [{ch, name, user:[câu], offline:câu, timer:[câu]}] — mọi DO có trong chương trình hoặc có tên.
 * names = {do:{1:"Bơm giếng"}, di:{3:"Phao giếng"}, f:{"bon.muc":"Bồn · Mức (%)"}} (board gửi kèm).
 */
export function describeLogic(prog, names = {}) {
  const nDo = (c) => (typeof c === 'string' ? names?.out?.[c] || names?.f?.[c] || c : names?.do?.[c] || `DO${c}`);
  const nDi = (c) => (names?.di?.[c] ? `${names.di[c]} (DI${c})` : `DI${c}`);
  const nF = (k) => names?.f?.[k] || k;
  const list = prog?.Do || prog?.do || [];
  const rows = [];
  if (list.some((o) => o.Out) || names?.out) {   // gateway PC: đầu ra theo field
    const outs = [...new Set([...list.filter((o) => o.Out).map((o) => o.Out), ...Object.keys(names?.out || {})])];
    for (const out of outs) rows.push(describeOne(list.find((x) => x.Out === out) || { Out: out, Mode: 'hold' }, out));
    return rows;
  }
  const chs = new Set([...list.map((o) => o.Ch), ...Object.keys(names?.do || {}).map(Number)]);
  for (const ch of [...chs].filter((c) => c >= 1 && c <= 8).sort((a, b) => a - b)) rows.push(describeOne(list.find((x) => x.Ch === ch) || { Ch: ch, Mode: 'hold' }, ch));
  return rows;

  function describeOne(o, ch) {
    const user = [];
    if (o.Need?.length) {
      const conds = o.Need.map((c) => (c.Di ? `${nDi(c.Di)} ${c.Is === 0 ? 'không có tín hiệu' : 'có tín hiệu'}` : `${nF(c.Field)} ${c.Op === '>=' ? '≥' : '≤'} ${num(c.Val)}`));
      user.push(`Chỉ cho BẬT khi ${conds.join(' và ')}.`);
      if (o.NeedHold) user.push('Đang chạy mà mất điều kiện thì tự TẮT.');
      if (o.Need.some((c) => c.Field)) user.push('Mất số liệu thì không cho bật.');
    }
    const blk = new Set(o.Block || []);
    for (const x of list) if ((x.Block || []).includes(ch)) blk.add(x.Out || x.Ch);   // liên động hai chiều
    if (blk.size) user.push(`Không bật cùng lúc với ${[...blk].sort().map(nDo).join(', ')}.`);
    if (o.MaxOnSec) user.push(`Chạy quá ${human(o.MaxOnSec)} thì tự tắt.`);
    if (!user.length) user.push('Bật/tắt tự do.');
    const timer = (o.Timer || []).map((t) => `${t.On ? `Bật ${t.On}` : ''}${t.On && t.Off ? ', ' : ''}${t.Off ? `tắt ${t.Off}` : ''} · ${daysV(t.Days)}`);
    const wait = o.DelaySec ? `Sau ${human(o.DelaySec)} mất mạng: ` : 'Ngay khi mất mạng: ';
    let off;
    switch (o.Mode) {
      case 'off': off = `${wait}tắt.`; break;
      case 'on': off = `${wait}bật.`; break;
      case 'schedule': off = `${wait}bật từ ${o.From} đến ${o.To}, ngoài giờ thì tắt. Không có giờ chính xác thì tắt.`; break;
      case 'follow': off = `${wait}${o.Invert ? 'ngược với' : 'theo'} ${o.Di ? nDi(o.Di) : nF(o.Field)}.`; break;
      case 'threshold': {
        const up = o.On > o.Off;
        off = `${wait}${nF(o.Field)} ${up ? '≥' : '≤'} ${num(o.On)} thì bật, ${up ? '≤' : '≥'} ${num(o.Off)} thì tắt. Mất số liệu thì tắt.`;
        break;
      }
      case 'cycle': off = `${wait}chạy ${human(o.OnSec)}, nghỉ ${human(o.OffSec)}, lặp lại.`; break;
      default: off = 'Giữ nguyên trạng thái.';
    }
    return { ch, id: String(ch), name: nDo(ch), user, timer, offline: off };
  }
}
