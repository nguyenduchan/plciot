/**
 * Phát hiện nghi ngờ gateway bị chép (hai máy cùng ID).
 * Broker chỉ cho một kết nối mỗi tài khoản MQTT: máy thứ hai vào sẽ đá máy thứ nhất ra, rồi máy thứ nhất
 * tự nối lại và đá ngược lại → trạng thái online/offline đổi liên tục. Ta đếm số lần ĐỔI trạng thái.
 * Không cần đụng cấu hình broker.
 */
const WINDOW_MS = Number(process.env.DUP_WINDOW_MS || 10 * 60_000);
const THRESHOLD = Number(process.env.DUP_THRESHOLD || 6);
const COOLDOWN_MS = Number(process.env.DUP_COOLDOWN_MS || 30 * 60_000);

const changes = new Map(); // key -> [ts…]
const lastAlert = new Map(); // key -> ts

/** Gọi mỗi khi trạng thái thiết bị đổi. Trả về số lần đổi trong cửa sổ nếu cần báo động, ngược lại null. */
export function noteStatusChange(key, now = Date.now()) {
  const arr = (changes.get(key) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  changes.set(key, arr);
  if (arr.length < THRESHOLD) return null;
  if (now - (lastAlert.get(key) || 0) < COOLDOWN_MS) return null;
  lastAlert.set(key, now);
  return arr.length;
}

export const dupConfig = { WINDOW_MS, THRESHOLD, COOLDOWN_MS };
