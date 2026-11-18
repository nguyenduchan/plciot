/**
 * Gộp telemetry schema:2 theo cửa sổ thời gian khi LƯU vào DB (gói miễn phí: mỗi 1 phút một dòng).
 * Gateway chỉ gửi khi dữ liệu ĐỔI (kịp thời) hoặc đủ chu kỳ lưu (không đổi), nên mẫu thưa và KHÔNG đều. Vì vậy trung bình tính THEO THỜI GIAN
 * (giữ giá trị cho tới mẫu kế tiếp — "sample and hold"), không phải theo số mẫu: giá trị đứng yên 55 giây rồi đổi 5 giây vẫn ra trung bình đúng.
 *
 * Mỗi dòng lưu: d = trung bình theo thời gian, agg = { n: số mẫu nhận, mn: nhỏ nhất, mx: lớn nhất }, w = độ dài cửa sổ.
 * Cửa sổ căn theo đồng hồ server: [bucket, bucket + everyMs); dòng lưu có ts = bucket (đầu cửa sổ).
 * Giá trị cuối của cửa sổ trước được GIỮ sang đầu cửa sổ sau nếu gateway còn gửi liên tục (mẫu cuối cách cuối cửa sổ <= 1,5 lần chu kỳ);
 * gateway im lặng lâu hơn thì không giữ (khoảng mất liên lạc không bị tính như có dữ liệu).
 * Cửa sổ cuối được đẩy ra khi sample kế tiếp sang cửa sổ mới hoặc khi sweep() thấy cửa sổ đã kết thúc.
 */
export function createTeleAggregator() {
  const states = new Map();   // key -> { bucket, every, fields: Map("child\0field" -> {start,last,lastTs,area,min,max}), samples, lastSampleTs, meta }
  const carry = new Map();    // key -> { bucket, every, until, values: Map(fieldKey -> value) }  (giá trị cuối của cửa sổ trước)

  function closeState(key, st) {
    const end = st.bucket + st.every;
    const d = {}; const mn = {}; const mx = {};
    const held = new Map();
    for (const [k, a] of st.fields) {
      const [child, field] = k.split('\0');
      const area = a.area + a.last * Math.max(0, end - a.lastTs);   // giữ giá trị cuối tới hết cửa sổ
      const dur = end - a.start;
      (d[child] ||= {})[field] = round(dur > 0 ? area / dur : a.last);
      (mn[child] ||= {})[field] = round(a.min);
      (mx[child] ||= {})[field] = round(a.max);
      held.set(k, a.last);
    }
    states.delete(key);
    // giữ giá trị sang cửa sổ kế nếu mẫu cuối còn "mới" (gateway còn gửi)
    if (end - st.lastSampleTs <= st.every * 1.5) carry.set(key, { until: end, every: st.every, values: held });
    else carry.delete(key);
    if (!Object.keys(d).length) return null;
    return { ts: st.bucket, meta: st.meta, payload: JSON.stringify({ schema: 2, ts: st.bucket, w: st.every, d, agg: { n: st.samples, mn, mx } }) };
  }

  /** Thêm một mẫu tại ts; trả về dòng { ts, meta, payload } cần lưu (cửa sổ trước vừa kết thúc) hoặc null. meta = thông tin người gọi cần để lưu (site/device). */
  function add(key, ts, d, everyMs, meta = null) {
    const bucket = Math.floor(ts / everyMs) * everyMs;
    let out = null;
    let st = states.get(key);
    if (st && (st.bucket !== bucket || st.every !== everyMs)) { out = closeState(key, st); st = null; }
    if (!st) {
      if (states.size > 50_000) { states.clear(); carry.clear(); }   // chặn phình bộ nhớ; hệ quả chỉ là mất một cửa sổ
      st = { bucket, every: everyMs, fields: new Map(), samples: 0, lastSampleTs: ts, meta };
      states.set(key, st);
      const c = carry.get(key);
      if (c && c.until === bucket && c.every === everyMs) {   // cửa sổ liền kề: giá trị cũ còn hiệu lực từ đầu cửa sổ
        for (const [k, v] of c.values) st.fields.set(k, { start: bucket, last: v, lastTs: bucket, area: 0, min: v, max: v });
      }
      carry.delete(key);
    }
    st.samples += 1;
    st.lastSampleTs = ts;
    for (const [child, fields] of Object.entries(d || {})) {
      if (!fields || typeof fields !== 'object') continue;
      for (const [field, v] of Object.entries(fields)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const k = child + '\0' + field;
        const a = st.fields.get(k);
        if (!a) st.fields.set(k, { start: ts, last: v, lastTs: ts, area: 0, min: v, max: v });
        else {
          a.area += a.last * Math.max(0, ts - a.lastTs);
          a.last = v; a.lastTs = ts;
          if (v < a.min) a.min = v;
          if (v > a.max) a.max = v;
        }
      }
    }
    return out;
  }

  /** Đẩy mọi cửa sổ đã kết thúc (bucket + every <= now). Trả mảng { key, ts, meta, payload }. */
  function sweep(now = Date.now()) {
    const rows = [];
    for (const [key, st] of [...states]) {
      if (st.bucket + st.every <= now) { const r = closeState(key, st); if (r) rows.push({ key, ...r }); }
    }
    for (const [key, c] of [...carry]) if (now - c.until > c.every * 2) carry.delete(key);   // dọn giá trị giữ đã quá hạn
    return rows;
  }

  return { add, sweep, size: () => states.size };
}

const round = (x) => Math.round(x * 1e6) / 1e6;
