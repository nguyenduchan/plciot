/**
 * Hồ sơ cỡ máy chủ: MỘT biến `SERVER_PROFILE` bật/tắt các tính năng theo cỡ VPS.
 *   small  — VPS nhỏ (≈2 CPU / 2 GB RAM): tắt phần chưa cần, lưu lịch sử tiết kiệm.
 *   large  — VPS lớn hơn: bật đủ (đúng hành vi trước khi có hồ sơ). Mặc định khi không đặt.
 *
 * Cách hoạt động: hồ sơ chỉ đặt GIÁ TRỊ MẶC ĐỊNH cho các biến môi trường CHƯA được đặt. Biến đặt tay trong `.env` luôn thắng,
 * nên muốn bật lại riêng một tính năng trên VPS nhỏ chỉ cần thêm đúng biến đó (ví dụ PARTNER_API_ENABLED=true).
 * File này phải được import ĐẦU TIÊN trong server.js: nhiều module đọc biến môi trường ngay lúc nạp.
 *
 * Phần RAM/CPU của container (broker, haproxy, app) nằm ở docker compose — xem khối "Hồ sơ cỡ máy chủ" trong cloud/.env.example.
 */

/** @type {Record<string, {label: string, env: Record<string, string>}>} */
export const SERVER_PROFILES = Object.freeze({
  small: {
    label: 'VPS nhỏ (2 CPU / 2 GB)',
    env: {
      // --- tính năng nền tảng chưa cần ở quy mô nhỏ
      PARTNER_API_ENABLED: 'false',     // chỉ các route dùng khoá API đối tác (đa tenant); /api/v1 của webapp + gateway vẫn chạy
      WEBHOOKS_ENABLED: 'false',        // không gọi webhook ra ngoài (mỗi sự kiện là một kết nối HTTPS đi)
      DEBUG_CLIENT_TRACE: 'false',      // nhật ký gỡ lỗi từ trình duyệt
      // --- lịch sử: SSD là thứ hết trước trên VPS nhỏ
      HISTORY_ON_CHANGE: 'true',        // chỉ lưu telemetry khi giá trị ĐỔI…
      HISTORY_HEARTBEAT_MS: '60000',    // …cộng một mẫu nhịp tim mỗi phút để đồ thị không đứt
      MQTT_INGEST_MIN_MS: '10000',      // và không dày hơn 1 mẫu/10 giây mỗi gateway (xem trực tiếp trên webapp không bị ảnh hưởng)
      // --- sao lưu + ảnh chat: bớt bản sao trên cùng ổ đĩa
      DB_BACKUP_DAILY: '3',
      DB_BACKUP_WEEKLY: '1',
      SUPPORT_USER_IMAGE_BYTES: String(5 * 1024 * 1024),
      SUPPORT_GLOBAL_IMAGE_BYTES: String(200 * 1024 * 1024),
      // --- việc nền chạy thưa hơn
      BUNDLE_SYNC_MS: '30000',
    },
  },
  large: {
    label: 'VPS lớn (bật đủ tính năng)',
    env: {},
  },
});

function pick() {
  const raw = String(process.env.SERVER_PROFILE || 'large').trim().toLowerCase();
  return SERVER_PROFILES[raw] ? raw : 'large';
}

const applied = [];
const overridden = [];

/** Áp hồ sơ vào process.env (chỉ biến chưa đặt). Gọi một lần lúc nạp module. */
export function applyServerProfile(env = process.env) {
  const name = pick();
  applied.length = 0; overridden.length = 0;
  for (const [k, v] of Object.entries(SERVER_PROFILES[name].env)) {
    if (env[k] == null || env[k] === '') { env[k] = v; applied.push(k); } else if (String(env[k]) !== v) overridden.push(k);
  }
  return name;
}

export const serverProfile = applyServerProfile();

/** Cho trang admin / log khởi động: hồ sơ đang dùng, biến do hồ sơ đặt và biến bị `.env` ghi đè. */
export function serverProfileInfo() {
  return { profile: serverProfile, label: SERVER_PROFILES[serverProfile].label, applied: [...applied], overridden: [...overridden], available: Object.keys(SERVER_PROFILES) };
}

/** Cờ bật/tắt dạng true/false đọc lúc dùng (mặc định bật nếu không đặt). */
export function featureOn(envKey, dflt = true) {
  const raw = process.env[envKey];
  if (raw == null || raw === '') return dflt;
  return !['false', '0', 'off', 'no'].includes(String(raw).toLowerCase());
}
