/**
 * Chặn bật/tắt đầu ra số quá nhanh (bảo vệ tiếp điểm relay, máy nén…): field của gateway khai `toggleMs` (PackMap.MinToggleMs trên gateway)
 * = thời gian tối thiểu giữa hai lần ĐỔI trạng thái. Server chặn TRƯỚC khi phát lệnh để webapp/script nhận lỗi ngay (429 + waitMs);
 * gateway và firmware board vẫn tự chặn lần cuối (không tin hoàn toàn server).
 * Chỉ lần ĐỔI giá trị mới tính: gửi lại đúng trạng thái vừa gửi luôn được (script lặp lệnh không bị khoá vô hạn).
 * Bộ nhớ trong tiến trình theo khoá gateway/child/key — đủ vì mỗi gateway chỉ thuộc một shard; gateway là chốt chặn thật.
 */
const last = new Map();   // `${site}/${device}/${child}/${key}` -> { v, at }
const MAX_ENTRIES = 50_000;

const k = (site, device, child, key) => `${site}/${device}/${child}/${key}`;

/** ms còn phải chờ trước khi được đổi sang v; 0 = được ngay. */
export function toggleWaitMs({ site, device, child, key, v, toggleMs, now = Date.now() }) {
  const min = Number(toggleMs) || 0;
  if (min <= 0) return 0;
  const s = last.get(k(site, device, child, key));
  if (!s || s.v === Number(v)) return 0;
  return Math.max(0, s.at + min - now);
}

/** Ghi nhận lệnh đã phát; chỉ lần ĐỔI giá trị mới đặt lại mốc. */
export function toggleRecord({ site, device, child, key, v, toggleMs, now = Date.now() }) {
  if (!(Number(toggleMs) > 0)) return;
  const id = k(site, device, child, key);
  const s = last.get(id);
  if (s && s.v === Number(v)) return;
  if (!s && last.size >= MAX_ENTRIES) {
    // dọn mục đã hết hạn chặn (không còn ảnh hưởng gì); vẫn đầy thì bỏ mục cũ nhất
    for (const [x, e] of last) if (now - e.at > (e.min || 0)) last.delete(x);
    if (last.size >= MAX_ENTRIES) last.delete(last.keys().next().value);
  }
  last.set(id, { v: Number(v), at: now, min: Number(toggleMs) });
}

export function _resetToggleGuard() { last.clear(); }
