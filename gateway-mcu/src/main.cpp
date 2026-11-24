// Gateway MCU (Waveshare ESP32-S3-POE-ETH-8DI-8DO) — chạy ĐỘC LẬP như gateway C#:
//   đọc PLC qua Modbus RTU (RS485) / Modbus TCP + I/O trên board, đẩy lên cloud MQTTS, nhận lệnh ký từ webapp,
//   cảnh báo ngưỡng, gửi bù dữ liệu offline. GatewayApp (C#) chỉ dùng để CÀI ĐẶT qua LAN (cùng giao diện với gateway PC).
// Luồng: task "poll" (core 1) đọc PLC theo PollMs; loop() (core 1, Arduino) lo mạng: API LAN, UDP tìm thiết bị, cloud, nút BOOT.
#include "gw.h"
#include "board.h"
#include <ETH.h>
#include <SPI.h>
#include <stdarg.h>

void logf(const char* fmt, ...) {
  char buf[384];
  va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
  Serial.printf("[%8lu] %s\n", (unsigned long)millis(), buf);
}

static volatile bool s_ethUp = false;

static void onNet(arduino_event_id_t ev, arduino_event_info_t) {
  switch (ev) {
    case ARDUINO_EVENT_ETH_START: ETH.setHostname("plciot-gw"); break;
    case ARDUINO_EVENT_ETH_CONNECTED: logf("Ethernet: đã cắm cáp"); break;
    case ARDUINO_EVENT_ETH_GOT_IP: s_ethUp = true; logf("Ethernet: IP %s (MAC %s)", ETH.localIP().toString().c_str(), ETH.macAddress().c_str()); break;
    case ARDUINO_EVENT_ETH_LOST_IP:
    case ARDUINO_EVENT_ETH_DISCONNECTED: s_ethUp = false; logf("Ethernet: mất kết nối"); break;
    default: break;
  }
}

/// LED: xanh lá = PLC online + cloud nối (hoặc cloud tắt); vàng = PLC lỗi / chưa có thiết bị; xanh dương = đang nối cloud; đỏ = mất mạng.
static void ledTick() {
  static uint32_t last = 0;
  if (millis() - last < 500) return;
  last = millis();
  String cs = cloudStateName();
  static bool blink = false; blink = !blink;
  if (g_locked) ioLed(blink ? 32 : 0, 0, 0);   // bị khoá (báo mất): đỏ nhấp nháy
  else if (!netUp()) ioLed(24, 0, 0);   // mất cả Ethernet lẫn Wi-Fi
  else if (g_status == "plc_fault" || g_status == "no_devices") ioLed(20, 14, 0);
  else if (cs == "Connecting" || cs == "Disconnected") ioLed(0, 0, 24);
  else ioLed(0, 20, 0);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  logf("Gateway Waveshare %s khởi động", FW_VERSION);
  ioBegin();
  Network.onEvent(onNet);
  if (!ETH.begin(ETH_PHY_W5500, 1, ETH_CS, ETH_INT, ETH_RST, SPI2_HOST, ETH_SCLK, ETH_MISO, ETH_MOSI))
    logf("Không khởi động được W5500 — kiểm tra chân SPI trong board.h");
  storeBegin();          // sau ETH.begin: tên thiết bị mặc định lấy từ MAC
  wifiBegin();           // Wi-Fi station song song Ethernet (mạng đã lưu tự nối)
  netApply();            // IP tĩnh mặc định 192.168.1.200 (hoặc DHCP / IP đã đặt) — cần NVS nên sau storeBegin
  cryptoBegin();
  modbusBegin();
  apiBegin();
  cloudBegin();
  engineBegin();
  logf("Thiết bị %s/%s · mã phần cứng %s · %u field", g_cfg.site.c_str(), g_cfg.device.c_str(), idHw().c_str(), (unsigned)g_cfg.pack.size());
}

void loop() {
  ioLoop();
  wifiLoop();
  serialCfgLoop();
  apiLoop();
  slaveLoop();
  cloudLoop();
  ledTick();
  delay(2);
}
