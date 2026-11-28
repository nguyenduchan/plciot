// Đồng hồ thời gian thực trên board: PCF85063 (I2C 0x51, chung bus với TCA9554 → mọi truy cập giữ IoLock).
// Wiki Waveshare chỉ ghi "Onboard RTC" + chân SDA42/SCL41/INT40, KHÔNG ghi tên chip: PCF85063 là chip Waveshare dùng trên các board
// ESP32-S3 cùng dòng — kiểm lại trên sơ đồ nguyên lý (xem board.h). Chip khác/không có thì rtcBegin() báo "không thấy" và mọi thứ chạy như cũ.
// RTC giữ giờ UTC. Cờ OS (bit 7 thanh ghi giây) = dao động đã dừng (mất nguồn nuôi) → giờ KHÔNG tin được, chờ giờ mạng.
#include "gw.h"
#include "board.h"
#include <Wire.h>
#include <sys/time.h>
#include <time.h>
#ifndef GW_SIM
#include <esp_sntp.h>
#endif

namespace {
bool s_found = false, s_valid = false;
volatile bool s_netTime = false, s_needWrite = false;
bool s_pcTime = false;                 // giờ do PC quản trị đặt qua LAN (GatewayApp) — dùng khi offline, không có giờ server
int64_t s_lastSyncMs = 0; String s_lastSyncBy;   // lần đặt giờ gần nhất (ms UTC) + nguồn: "server" | "PC <tên> (<ip>)"
uint32_t s_lastWrite = 0; bool s_wrote = false;

uint8_t fromBcd(uint8_t v) { return (v >> 4) * 10 + (v & 0x0F); }
uint8_t toBcd(int v) { return (uint8_t)(((v / 10) << 4) | (v % 10)); }

// Lịch Gregory ↔ số ngày từ 1970-01-01 (H. Hinnant) — không phụ thuộc biến TZ của hệ thống.
int64_t daysFromCivil(int y, int m, int d) {
  y -= m <= 2;
  int64_t era = (y >= 0 ? y : y - 399) / 400;
  int yoe = (int)(y - era * 400), doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1, doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}
void civilFromDays(int64_t z, int& y, int& m, int& d) {
  z += 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  int doe = (int)(z - era * 146097), yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365, doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1; m = mp + (mp < 10 ? 3 : -9); y = (int)(yoe + era * 400) + (m <= 2);
}

bool probe() { IoLock l; Wire.beginTransmission(PCF85063_ADDR); return Wire.endTransmission() == 0; }

/// false = không đọc được, cờ OS bật, hoặc giá trị ngoài khoảng (chip khác / chưa từng đặt giờ).
bool readRtc(time_t& out) {
  uint8_t r[7];
  {
    IoLock l;
    Wire.beginTransmission(PCF85063_ADDR); Wire.write(0x04);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)PCF85063_ADDR, 7) != 7) return false;
    for (auto& b : r) b = (uint8_t)Wire.read();
  }
  if (r[0] & 0x80) return false;
  int sec = fromBcd(r[0] & 0x7F), min = fromBcd(r[1] & 0x7F), hr = fromBcd(r[2] & 0x3F), day = fromBcd(r[3] & 0x3F);
  int mon = fromBcd(r[5] & 0x1F), yr = 2000 + fromBcd(r[6]);
  if (sec > 59 || min > 59 || hr > 23 || day < 1 || day > 31 || mon < 1 || mon > 12 || yr < 2024) return false;
  out = (time_t)(daysFromCivil(yr, mon, day) * 86400 + hr * 3600 + min * 60 + sec);
  return true;
}

bool writeRtc(time_t t) {
  int64_t days = (int64_t)t / 86400; int s = (int)((int64_t)t % 86400);
  int y, m, d; civilFromDays(days, y, m, d);
  if (y < 2024 || y > 2099) return false;
  uint8_t w[7] = {toBcd(s % 60), toBcd(s / 60 % 60), toBcd(s / 3600), toBcd(d), (uint8_t)((days + 4) % 7), toBcd(m), toBcd(y - 2000)};   // 1970-01-01 là thứ Năm (4); bit OS = 0
  IoLock l;
  uint8_t c1 = 0;
  Wire.beginTransmission(PCF85063_ADDR); Wire.write(0x00);   // Control_1: bit 1 = 12/24h → giữ 24h, bit 5 = STOP → chạy
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom((int)PCF85063_ADDR, 1) != 1) return false;
  c1 = (uint8_t)Wire.read();
  if (c1 & 0x22) { Wire.beginTransmission(PCF85063_ADDR); Wire.write(0x00); Wire.write(c1 & ~0x22); if (Wire.endTransmission() != 0) return false; }
  Wire.beginTransmission(PCF85063_ADDR); Wire.write(0x04);
  for (uint8_t b : w) Wire.write(b);
  return Wire.endTransmission() == 0;
}

String fmt(time_t t) {
  int y, m, d; int64_t days = (int64_t)t / 86400; int s = (int)((int64_t)t % 86400); civilFromDays(days, y, m, d);
  char b[32]; snprintf(b, sizeof b, "%04d-%02d-%02d %02d:%02d:%02d", y, m, d, s / 3600, s / 60 % 60, s % 60);
  return b;
}

#ifndef GW_SIM
void onSntp(struct timeval*) { rtcNoteNetTime(); }
#endif
}  // namespace

void rtcBegin() {
#ifndef GW_SIM
  sntp_set_time_sync_notification_cb(onSntp);   // NTP đồng bộ xong (lần đầu + định kỳ) → ghi xuống RTC
#endif
  s_found = probe();
  if (!s_found) { logf("Không thấy RTC (PCF85063 0x%02X) — khởi động lúc mất mạng sẽ chưa có giờ", PCF85063_ADDR); return; }
  time_t t;
  if (readRtc(t)) {
    struct timeval tv = {t, 0};
    settimeofday(&tv, nullptr);
    s_valid = true;
    logf("Giờ lấy từ RTC: %s UTC", fmt(t).c_str());
  } else {
    logf("RTC chưa có giờ hợp lệ (mất nguồn nuôi / mới lắp) — chờ giờ mạng");
  }
}

void rtcNoteNetTime() { s_netTime = true; s_needWrite = true; s_lastSyncMs = (int64_t)time(nullptr) * 1000; s_lastSyncBy = "server"; }

void rtcLoop() {
  if (!s_found || !s_needWrite) return;
  if (s_wrote && millis() - s_lastWrite < 3600000UL) return;   // NTP đồng bộ lại định kỳ: ghi RTC tối đa 1 lần/giờ
  time_t now = time(nullptr);
  if (now < 1700000000) return;
  s_needWrite = false;
  if (writeRtc(now)) {
    if (!s_wrote) logf("Đã ghi giờ mạng xuống RTC: %s UTC", fmt(now).c_str());
    s_wrote = true; s_valid = true; s_lastWrite = millis();
  } else {
    logf("Ghi RTC lỗi");
  }
}

bool timeTrusted() {
#ifdef GW_SIM
  return true;   // bản giả lập dùng giờ của PC
#else
  return s_netTime || s_valid || s_pcTime;
#endif
}

const char* timeSource() { return s_netTime ? "ntp" : s_pcTime ? "pc" : s_valid ? "rtc" : "none"; }

// ---------------------------------------------------------------- QUẢN LÝ GIỜ KHI OFFLINE (GatewayApp qua LAN)
// Board không có internet mà RTC mất giờ (mất nguồn nuôi / board mới) → không có giờ tin được → mọi hẹn giờ TẮT. PC quản trị đã ghép
// (GatewayApp, kênh HTTPS ghim khoá) đặt giờ theo đồng hồ PC: ghi giờ hệ thống + RTC. Giờ SERVER luôn ưu tiên: đã có giờ server thì
// PC chỉ đặt được khi Force (PC giờ sai sẽ làm lệch hẹn giờ + chống phát lại lệnh ký ±5 phút). Mỗi lần đặt ghi nhật ký sự kiện.
bool rtcSetFromPc(int64_t ms, const String& by, bool force, String& err) {
  if (ms < 1704067200000LL || ms > 4102444800000LL) { err = "bad_time"; return false; }   // 2024-01-01 … 2100-01-01
  int64_t before = (int64_t)time(nullptr) * 1000;
  if (s_netTime && !force) { err = "time_from_server"; return false; }
  struct timeval tv = {}; tv.tv_sec = (time_t)(ms / 1000); tv.tv_usec = (long)((ms % 1000) * 1000);   // không dùng suseconds_t (bản giả lập MinGW)
  settimeofday(&tv, nullptr);
  s_pcTime = true;
  bool rtcOk = !s_found || writeRtc((time_t)(ms / 1000));
  if (s_found && rtcOk) { s_valid = true; s_wrote = true; s_lastWrite = millis(); }
  s_lastSyncMs = ms; s_lastSyncBy = by;
  long long d = before > 1700000000000LL ? (long long)(ms - before) : 0;
  evLog("time_set", "Đặt giờ từ " + by + ": " + fmt((time_t)(ms / 1000)) + " UTC" + (before > 1700000000000LL ? " (lệch " + String((long)(d / 1000)) + " s)" : " (trước đó chưa có giờ)") + (rtcOk ? "" : " — ghi RTC lỗi"));
  if (!rtcOk) { err = "rtc_write_failed"; return false; }
  return true;
}

String rtcStatusJson() {
  JsonDocument o;
  int64_t now = (int64_t)time(nullptr) * 1000;
  o["Ok"] = true; o["NowMs"] = now > 1700000000000LL ? now : 0; o["Source"] = timeSource(); o["Trusted"] = timeTrusted();
  o["RtcFound"] = s_found; o["RtcValid"] = s_valid;
  time_t rt;
  if (s_found && readRtc(rt)) { o["RtcMs"] = (int64_t)rt * 1000; if (now > 1700000000000LL) o["RtcDriftMs"] = (int64_t)rt * 1000 - (now / 1000) * 1000; }
  if (s_lastSyncMs) { o["LastSyncMs"] = s_lastSyncMs; o["LastSyncBy"] = s_lastSyncBy; }
  o["UpSec"] = millis() / 1000;
  String s; serializeJson(o, s); return s;
}
