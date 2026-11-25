// Watchdog cho chế độ chạy độc lập (trạm không người trông): task nào treo thì board tự khởi động lại thay vì đứng im với DO giữ nguyên.
//   - Watchdog PHẦN MỀM theo từng task (loop mạng, poll PLC, lấy mẫu DI, kiểm TCA9554), mỗi task một hạn riêng — loop() có thể bận
//     lâu hợp lệ (HTTPS 30 s, OTA) nên không dùng chung một hạn ngắn như Task WDT của ESP-IDF.
//   - Task giám sát tự đăng ký với Task WDT phần cứng: chính nó (hoặc cả scheduler) treo thì chip reset.
// Quá hạn → ghi tên task vào NVS "wdt" → ESP.restart(). Lần khởi động sau bootReason() = "wdt:<task>" (log + GET /api/state).
#include "gw.h"
#include <Preferences.h>
#ifndef GW_SIM
#include <esp_task_wdt.h>
#include <esp_system.h>
#endif

namespace {
struct Slot { const char* name; volatile uint32_t last; volatile uint32_t timeout; };   // timeout 0 = chưa canh
Slot s_slots[WD_COUNT] = {{"loop", 0, 0}, {"poll", 0, 0}, {"di", 0, 0}, {"io", 0, 0}};
String s_boot = "unknown";

#ifndef GW_SIM
const char* resetName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "ext_pin";
    case ESP_RST_SW: return "sw";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    default: return "unknown";
  }
}
#endif

void supervisor(void*) {
#ifndef GW_SIM
  if (esp_task_wdt_add(nullptr) == ESP_ERR_INVALID_STATE) {   // Task WDT chưa được khởi tạo trong sdkconfig → tự khởi tạo
    esp_task_wdt_config_t c = {};
    c.timeout_ms = 5000; c.trigger_panic = true;
    esp_task_wdt_init(&c);
    esp_task_wdt_add(nullptr);
  }
#endif
  for (;;) {
#ifndef GW_SIM
    esp_task_wdt_reset();
#endif
    uint32_t now = millis();
    for (auto& s : s_slots) {
      uint32_t to = s.timeout, el = now - s.last;
      if (!to || el <= to) continue;
      logf("WATCHDOG: task \"%s\" không phản hồi %lu ms (hạn %lu) — khởi động lại", s.name, (unsigned long)el, (unsigned long)to);
      Preferences p; p.begin("gw", false); p.putString("wdt", s.name); p.end();
      delay(200);
      ESP.restart();
    }
    delay(500);
  }
}
}  // namespace

void wdtBegin() {
  Preferences p; p.begin("gw", false);
  String w = p.isKey("wdt") ? p.getString("wdt", "") : String();
  if (w.length()) p.remove("wdt");
  p.end();
#ifndef GW_SIM
  s_boot = w.length() ? "wdt:" + w : String(resetName(esp_reset_reason()));
#else
  s_boot = w.length() ? "wdt:" + w : String("sim");
#endif
  logf("Lý do khởi động: %s", s_boot.c_str());
  xTaskCreatePinnedToCore(supervisor, "wdt", 4096, nullptr, 5, nullptr, 0);
}

void wdtArm(int id, uint32_t timeoutMs) {
  if (id < 0 || id >= WD_COUNT) return;
  s_slots[id].last = millis();
  s_slots[id].timeout = timeoutMs;
}

void wdtFeed(int id) {
  if (id >= 0 && id < WD_COUNT) s_slots[id].last = millis();
}

String bootReason() { return s_boot; }
