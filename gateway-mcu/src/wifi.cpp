// Wi-Fi của board (ESP32-S3-WROOM-1U): chế độ STATION chạy SONG SONG với Ethernet — Ethernet vẫn là đường chính (ưu tiên netif cao hơn),
// Wi-Fi để dự phòng / nơi không kéo được dây. Cấu hình qua LAN bằng GatewayApp (API /api/wifi*):
//   GET  /api/wifi/scan  → [{Ssid, Rssi, Open}]            (quét ~3 giây, bỏ trùng SSID giữ sóng mạnh nhất)
//   GET  /api/wifi       → {Saved, Connected, Ssid, Rssi, Ip}  (KHÔNG trả mật khẩu)
//   PUT  /api/wifi {Ssid, Password} → nối thử tối đa ~15 giây; thành công mới lưu NVS ("wifi_ssid"/"wifi_pass"); thất bại giữ cấu hình cũ
//   Ssid rỗng → quên mạng đã lưu.
#include "gw.h"

#ifdef GW_SIM
// Bản giả lập trên PC không có Wi-Fi.
void wifiBegin() {}
void wifiLoop() {}
String wifiScanJson() { return "[]"; }
String wifiStatusJson() { return "{\"Supported\":false,\"Saved\":\"\",\"Connected\":false}"; }
bool wifiConnect(const String&, const String&, String& err) { err = "wifi_unsupported"; return false; }
#else
#include <WiFi.h>
#include <esp_netif.h>
#include <ArduinoJson.h>

namespace {
const uint32_t kConnectMs = 15000;
}

namespace {
/// Đường ra Internet của netif MẶC ĐỊNH có thông không: TCP :443 tới 8.8.8.8 / 1.1.1.1 (không cần DNS, không tốn băng thông).
bool internetReachable() {
  static const IPAddress hosts[] = { IPAddress(8, 8, 8, 8), IPAddress(1, 1, 1, 1) };
  for (const IPAddress& h : hosts) {
    WiFiClient c;
    if (c.connect(h, 443, 2500)) { c.stop(); return true; }
  }
  return false;
}
void setDefaultNetif(int which) {   // 1 = Ethernet, 2 = Wi-Fi
  esp_netif_t* h = esp_netif_get_handle_from_ifkey(which == 1 ? "ETH_DEF" : "WIFI_STA_DEF");
  if (h) esp_netif_set_default_netif(h);
}
}  // namespace

static bool s_apOn = false;
static uint32_t s_bootAt = 0, s_okSince = 0;

void wifiBegin() {
  s_bootAt = millis();
  WiFi.mode(WIFI_STA);          // luôn bật radio để quét được kể cả khi chưa có mạng nào lưu
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);       // thông tin mạng nằm trong NVS của ta, không để lib ghi thêm vào flash
  WiFi.setHostname("plciot-gw");
  String ssid = secretGet("wifi_ssid");
  if (ssid.length()) {
    WiFi.begin(ssid.c_str(), secretGet("wifi_pass").c_str());
    logf("Wi-Fi: đang nối \"%s\" (đã lưu)", ssid.c_str());
  } else logf("Wi-Fi: chưa cấu hình mạng nào (quét/nối bằng GatewayApp → Wi-Fi…)");
}

// ---- Hotspot cài đặt: không dây Ethernet và chưa nối được Wi-Fi nào → phát "PLCIOT-xxxx" (mở, IP 192.168.4.1) để PC/điện thoại nối vào
// rồi cài Wi-Fi bằng GatewayApp. Tự tắt khi có dây hoặc nối được Wi-Fi. Mạng mở nhưng API vẫn cần khoá PC đã ghép (hoặc cửa sổ BOOT).

static String apName() { String m = WiFi.macAddress(); m.replace(":", ""); return "PLCIOT-" + m.substring(m.length() - 4); }

void wifiLoop() {
  static uint32_t last = 0;
  if (millis() - last < 1000) return;
  last = millis();
  bool eth = netEthUp(), sta = WiFi.status() == WL_CONNECTED;
  // ƯU TIÊN: Ethernet (khi dây cắm, link lên) > Wi-Fi. Không chọn theo "chất lượng": dây ổn định/độ trễ thấp hơn, RSSI không so được với dây, và chọn theo đo đạc
  // sẽ nhảy qua lại làm đứt MQTT/Modbus. Wi-Fi luôn nối sẵn làm dự phòng nóng: rút dây → chuyển sang Wi-Fi ngay, cắm lại → quay về dây.
  // NGOẠI LỆ: dây có link nhưng KHÔNG ra Internet (vd. cắm thẳng vào PC để cài đặt) mà Wi-Fi đang nối → cloud phải đi bằng Wi-Fi.
  //   Chỉ thăm dò khi cả hai cùng lên và cloud đang không nối được (cloud nối được = dây ra Internet tốt): 3 lần liền (mỗi 10 giây) không thông
  //   → chuyển sang Wi-Fi; mỗi 5 phút thử lại dây một lần (chuyển tạm, thăm dò, không thông thì trả về Wi-Fi) để dây ra Internet thì quay lại.
  // Đặt rõ netif mặc định (đường ra Internet/cloud) thay vì để lwIP tự chọn theo thứ tự thiết lập.
  static int s_pref = 0, s_fails = 0;
  static bool s_ethBad = false;
  static uint32_t s_nextProbe = 0, s_ethRetryAt = 0;
  uint32_t now = millis();
  if (!eth) { s_ethBad = false; s_fails = 0; }
  if (eth && sta) {
    if (s_ethBad) {
      if ((int32_t)(now - s_ethRetryAt) >= 0) {
        setDefaultNetif(1);
        if (internetReachable()) { s_ethBad = false; s_fails = 0; logf("Ethernet đã ra được Internet — quay về dây"); }
        else { setDefaultNetif(2); s_ethRetryAt = millis() + 300000; }
      }
    } else if (s_pref == 1 && cloudLinkOk()) {
      s_fails = 0;
    } else if (s_pref == 1 && (int32_t)(now - s_nextProbe) >= 0) {
      s_nextProbe = now + 10000;
      if (internetReachable()) s_fails = 0;
      else if (++s_fails >= 3) {
        s_ethBad = true; s_fails = 0; s_ethRetryAt = millis() + 300000;
        logf("Ethernet có link nhưng không ra được Internet — chuyển cloud sang Wi-Fi");
      }
    }
  }
  int want = eth ? ((s_ethBad && sta) ? 2 : 1) : (sta ? 2 : 0);
  if (want && want != s_pref) {
    setDefaultNetif(want);
    logf("Mạng chính: %s", want == 1 ? "Ethernet" : "Wi-Fi");
    if (s_pref) cloudRestart();   // đổi đường: nối MQTT lại để khỏi chờ timeout của socket cũ
    s_pref = want;
  }
  bool saved = secretGet("wifi_ssid").length() > 0;
  uint32_t grace = saved ? 30000 : 10000;   // mạng đã lưu cần thời gian nối; chưa lưu thì chờ ETH báo link
  if (!eth && !sta) {
    s_okSince = 0;
    if (!s_apOn && millis() - s_bootAt > grace) {
      WiFi.mode(WIFI_AP_STA);
      WiFi.softAP(apName().c_str(), nullptr, 1, 0, 4);   // mở, kênh 1, tối đa 4 máy
      s_apOn = true;
      logf("Hotspot cài đặt: nối Wi-Fi \"%s\" (không mật khẩu), mở GatewayApp → tìm thiết bị / IP %s", apName().c_str(), WiFi.softAPIP().toString().c_str());
    }
  } else if (s_apOn) {
    if (!s_okSince) s_okSince = millis();
    if (millis() - s_okSince > 5000) {   // đã có dây / Wi-Fi ổn định → tắt hotspot
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_STA);
      s_apOn = false; s_okSince = 0;
      logf("Hotspot cài đặt: đã tắt (có %s)", eth ? "Ethernet" : "Wi-Fi");
    }
  }
}

String wifiScanJson() {
  int n = WiFi.scanNetworks(false, true);   // đồng bộ, hiện cả mạng ẩn tên bị bỏ ở dưới
  JsonDocument d; JsonArray arr = d.to<JsonArray>();
  if (n > 0) {
    // bỏ trùng SSID (nhiều AP cùng tên): giữ sóng mạnh nhất; bỏ mạng ẩn (SSID rỗng)
    for (int i = 0; i < n; i++) {
      String s = WiFi.SSID(i);
      if (!s.length()) continue;
      bool dup = false;
      for (JsonObject o : arr) if (s == (const char*)o["Ssid"]) { dup = true; if (WiFi.RSSI(i) > (int)o["Rssi"]) o["Rssi"] = WiFi.RSSI(i); break; }
      if (dup) continue;
      JsonObject o = arr.add<JsonObject>();
      o["Ssid"] = s; o["Rssi"] = WiFi.RSSI(i); o["Open"] = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
    }
  }
  WiFi.scanDelete();
  String out; serializeJson(d, out);
  logf("Wi-Fi: quét thấy %d mạng", n < 0 ? 0 : (int)arr.size());
  return out;
}

String wifiStatusJson() {
  JsonDocument d;
  bool up = WiFi.status() == WL_CONNECTED;
  d["Supported"] = true; d["Saved"] = secretGet("wifi_ssid"); d["Connected"] = up;
  if (up) { d["Ssid"] = WiFi.SSID(); d["Rssi"] = WiFi.RSSI(); d["Ip"] = WiFi.localIP().toString(); }
  d["Mac"] = WiFi.macAddress();
  String out; serializeJson(d, out); return out;
}

bool wifiConnect(const String& ssid, const String& pass, String& err) {
  if (!ssid.length()) {   // quên mạng đã lưu
    secretSet("wifi_ssid", ""); secretSet("wifi_pass", "");
    WiFi.disconnect(true, false);
    logf("Wi-Fi: đã quên mạng đã lưu");
    return true;
  }
  if (ssid.length() > 32) { err = "wifi_ssid_too_long"; return false; }
  if (pass.length() && (pass.length() < 8 || pass.length() > 63)) { err = "wifi_password_length"; return false; }
  String oldSsid = secretGet("wifi_ssid"), oldPass = secretGet("wifi_pass");
  WiFi.disconnect(false, false);
  WiFi.begin(ssid.c_str(), pass.c_str());
  uint32_t t0 = millis(); wl_status_t st = WL_IDLE_STATUS;
  while (millis() - t0 < kConnectMs) {
    st = WiFi.status();
    if (st == WL_CONNECTED || st == WL_NO_SSID_AVAIL || st == WL_CONNECT_FAILED) break;
    delay(250);
  }
  if (st == WL_CONNECTED) {
    secretSet("wifi_ssid", ssid); secretSet("wifi_pass", pass);
    logf("Wi-Fi: đã nối \"%s\" — IP %s, sóng %d dBm", ssid.c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
  }
  err = st == WL_NO_SSID_AVAIL ? "wifi_not_found" : st == WL_CONNECT_FAILED ? "wifi_auth_failed" : "wifi_timeout";
  logf("Wi-Fi: nối \"%s\" thất bại (%s)", ssid.c_str(), err.c_str());
  WiFi.disconnect(false, false);
  if (oldSsid.length()) WiFi.begin(oldSsid.c_str(), oldPass.c_str());   // quay về mạng đã lưu trước đó
  return false;
}
#endif
