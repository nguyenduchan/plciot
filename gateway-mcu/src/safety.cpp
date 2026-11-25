// An toàn khi chạy độc lập (trạm không người trông):
//   1. CHẾ ĐỘ AN TOÀN khi khởi động lại liên tục: panic / watchdog / sụt áp ≥ kSafeAfter lần liền, mỗi lần chưa chạy đủ kStableMs.
//      Nguyên nhân hay gặp: tải trên DO gây sụt áp → reset → bật lại tải → reset... Giữ DO TẮT, từ chối lệnh BẬT ("safe_mode")
//      cho tới khi chạy ổn định kSafeHoldMs. Tắt nguồn bật lại (power_on) hay khởi động lại bình thường (OTA, đổi mạng) xoá bộ đếm.
//   2. TẮT DO KHI MẤT NGƯỜI ĐIỀU KHIỂN (Field::lossOffSec, theo từng chân): không ai thấy/tắt được từ xa thì không để tải chạy mãi.
//      Hạn tính từ lúc mất kết nối, hoặc từ lần đổi DO gần nhất nếu muộn hơn (bật tay qua LAN lúc mất mạng vẫn chỉ giữ ngần ấy).
//      Không tự bật lại khi có kết nối. Vẫn tôn trọng thời gian tối thiểu giữa 2 lần bật/tắt (đợi đủ rồi mới tắt).
#include "gw.h"
#include <Preferences.h>

namespace {
const uint32_t kSafeAfter = 3;                    // số lần khởi động lại bất thường liên tiếp → chế độ an toàn
const uint32_t kStableMs = 120000;                // chạy đủ ngần này = ổn định, xoá bộ đếm
const uint32_t kSafeHoldMs = 30UL * 60 * 1000;    // chế độ an toàn tự hết sau ngần này (đã chạy ổn định)

uint32_t s_bootMs = 0, s_fails = 0;
volatile bool s_safe = false;
bool s_cleared = false;

uint32_t s_loss[8] = {0};
volatile bool s_expected = false;
volatile uint32_t s_lastUp = 0;                   // millis lần cuối còn người điều khiển (hoặc chưa cần ai)
bool s_hadLease = false;
bool s_wasDown = false;

bool abnormal(const String& r) {
  return r.startsWith("wdt") || r == "panic" || r == "int_wdt" || r == "task_wdt" || r == "brownout";
}

void saveFails(uint32_t n) { Preferences p; p.begin("gw", false); p.putString("bootfail", String(n)); p.end(); }
}  // namespace

void safetyBegin() {
  s_bootMs = s_lastUp = millis();
  Preferences p; p.begin("gw", false);
  uint32_t n = p.isKey("bootfail") ? (uint32_t)p.getString("bootfail", "0").toInt() : 0;
  p.end();
  n = abnormal(bootReason()) ? n + 1 : 0;
  saveFails(n);
  s_fails = n;
  s_safe = n >= kSafeAfter;
  if (s_safe) logf("⚠ CHẾ ĐỘ AN TOÀN: khởi động lại bất thường %lu lần liền (%s) — DO giữ TẮT, từ chối lệnh BẬT trong %lu phút",
                   (unsigned long)n, bootReason().c_str(), (unsigned long)(kSafeHoldMs / 60000));
  else if (n) logf("Khởi động lại bất thường lần %lu liên tiếp (%s)", (unsigned long)n, bootReason().c_str());
}

bool safeMode() { return s_safe; }
uint32_t safetyBootFails() { return s_fails; }

void safetyLossCfg(const uint32_t* sec8) { for (int i = 0; i < 8; i++) s_loss[i] = sec8[i]; }

void safetyLink(bool cloudExpected, bool lease, bool cloudUp) {
  if (lease) s_hadLease = true;   // đã từng có PC giữ lease: PC mất thì vẫn là mất người điều khiển (kể cả cloud tắt)
  bool expected = cloudExpected || lease || s_hadLease, up = lease || cloudUp;
  if (!expected || up) s_lastUp = millis();
  if (s_wasDown && up) logf("Có lại người điều khiển (%s)", lease ? "PC giữ lease" : "cloud");
  s_wasDown = expected && !up;
  s_expected = expected;
}

void safetyTick() {
  uint32_t now = millis(), up = now - s_bootMs;
  if (!s_cleared && up >= kStableMs) { s_cleared = true; if (s_fails) saveFails(0); }
  if (s_safe && up >= kSafeHoldMs) { s_safe = false; logf("Hết chế độ an toàn (đã chạy ổn định %lu phút) — nhận lệnh DO bình thường", (unsigned long)(up / 60000)); }

  if (!s_expected) return;
  IoLock l;
  uint8_t d = ioDo(), off = 0;
  uint32_t sinceLink = now - s_lastUp;
  for (int i = 0; i < 8; i++) {
    if (!s_loss[i] || !(d & (1 << i))) continue;
    uint32_t chg = ioDoLastChange(i), sinceChg = chg ? now - chg : sinceLink;
    if (min(sinceLink, sinceChg) >= s_loss[i] * 1000UL) off |= 1 << i;
  }
  if (!off) return;
  uint8_t m = d & ~off;
  if (ioDoWaitMs(m)) return;   // chưa đủ thời gian tối thiểu giữa 2 lần bật/tắt: lần sau (500 ms)
  if (ioSetDo(m)) logf("Mất người điều khiển %lu s — tự TẮT DO 0x%02X (còn 0x%02X)", (unsigned long)(sinceLink / 1000), off, m);
}
