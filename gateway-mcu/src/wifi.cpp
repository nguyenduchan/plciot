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
#include <ETH.h>
#include <esp_netif.h>
#include <Network.h>
#include <lwip/sockets.h>
#include <ArduinoJson.h>

namespace {
const uint32_t kConnectMs = 15000;
}

namespace {
/// Đường ra Internet QUA MỘT CỔNG CỤ THỂ có thông không: TCP tới CHÍNH máy chủ cloud (broker MQTTS của VPS — đúng địa chỉ trong cấu hình cloud),
/// socket GẮN địa chỉ nguồn của cổng đó (lwIP ESP-IDF định tuyến theo địa chỉ nguồn) → thử được dây mà KHÔNG phải đổi đường mặc định.
/// Gateway chỉ nói chuyện với máy chủ của hệ thống — không thăm dò máy chủ bên thứ ba. Chưa cài cloud: coi như thông.
bool reachableVia(const IPAddress& src) {
  if (!g_cfg.cloudHost.length() || g_cfg.cloudPort <= 0) return true;
  IPAddress dst;
  if (!dst.fromString(g_cfg.cloudHost) && !Network.hostByName(g_cfg.cloudHost.c_str(), dst)) return false;
  int s = lwip_socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) return false;
  bool ok = false;
  sockaddr_in a = {}; a.sin_family = AF_INET; a.sin_addr.s_addr = (uint32_t)src;
  if (lwip_bind(s, (sockaddr*)&a, sizeof(a)) == 0) {
    lwip_fcntl(s, F_SETFL, lwip_fcntl(s, F_GETFL, 0) | O_NONBLOCK);
    sockaddr_in d = {}; d.sin_family = AF_INET; d.sin_port = htons(g_cfg.cloudPort); d.sin_addr.s_addr = (uint32_t)dst;
    if (lwip_connect(s, (sockaddr*)&d, sizeof(d)) == 0) ok = true;
    else if (errno == EINPROGRESS) {
      fd_set w; FD_ZERO(&w); FD_SET(s, &w);
      timeval tv = {2, 500000};
      if (lwip_select(s + 1, nullptr, &w, nullptr, &tv) > 0) { int e = 0; socklen_t l = sizeof(e); lwip_getsockopt(s, SOL_SOCKET, SO_ERROR, &e, &l); ok = e == 0; }
    }
  }
  lwip_close(s);
  return ok;
}
bool sameNet(const IPAddress& a, const IPAddress& b, const IPAddress& m) { return ((uint32_t)a & (uint32_t)m) == ((uint32_t)b & (uint32_t)m); }
void setDns(esp_netif_t* h, const IPAddress& a, const IPAddress& b) {
  esp_netif_dns_info_t d = {};
  d.ip.type = ESP_IPADDR_TYPE_V4; d.ip.u_addr.ip4.addr = (uint32_t)a; esp_netif_set_dns_info(h, ESP_NETIF_DNS_MAIN, &d);
  d.ip.u_addr.ip4.addr = (uint32_t)b; esp_netif_set_dns_info(h, ESP_NETIF_DNS_BACKUP, &d);
}
void setDefaultNetif(int which) {   // 1 = Ethernet, 2 = Wi-Fi
  esp_netif_t* h = esp_netif_get_handle_from_ifkey(which == 1 ? "ETH_DEF" : "WIFI_STA_DEF");
  if (!h) return;
  esp_netif_set_default_netif(h);
  // KHÔNG ép DNS công cộng (8.8.8.8 / 1.1.1.1): mạng công ty chặn DNS ra ngoài (sự cố 2026-11-27 — HTTPS tới plc.dieukhientudong.net lỗi
  // "getaddrinfo() returns 202", không cập nhật firmware được). Wi-Fi dùng đúng DNS DHCP cấp; Ethernet IP tĩnh dùng DNS đồng bộ ở ethDnsSync.
}

/// Ethernet IP TĨNH, DNS tự động (netDnsAuto): DNS = DNS DHCP của Wi-Fi (mạng thật cấp, vd. DNS nhà mạng / DNS nội bộ công ty), không có
/// Wi-Fi thì router Ethernet. Người dùng đặt DNS riêng (GatewayApp → Mạng) thì giữ nguyên. Gọi định kỳ: DHCP Wi-Fi gia hạn có thể đổi DNS.
void ethDnsSync() {
  if (secretGet("net_mode") == "dhcp" || !netDnsAuto() || !ETH.linkUp()) return;
  esp_netif_t* h = esp_netif_get_handle_from_ifkey("ETH_DEF");
  if (!h) return;
  IPAddress z(0, 0, 0, 0), a = z, b = z;
  if (WiFi.status() == WL_CONNECTED) { a = WiFi.dnsIP(0); b = WiFi.dnsIP(1); }
  if (a == z) { a = ETH.gatewayIP(); b = z; }
  if (b == z || b == a) b = ETH.gatewayIP() != a ? ETH.gatewayIP() : z;
  static IPAddress s_a, s_b;
  if (a == s_a && b == s_b) return;
  s_a = a; s_b = b;
  setDns(h, a, b);
  logf("Ethernet: DNS theo mạng %s%s", a.toString().c_str(), b != z ? (", " + b.toString()).c_str() : "");
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
  // CHỌN ĐƯỜNG RA INTERNET (netif mặc định) khi có cả Ethernet và Wi-Fi — cài "net_pref" (GatewayApp / PUT /api/network {Pref}):
  //   "wifi" = luôn Wi-Fi; "eth" = luôn dây; "auto" (mặc định) = Wi-Fi, CHỈ dùng dây khi đã THỬ QUA DÂY (socket gắn IP dây, không đổi đường)
  //   nối được máy chủ cloud. Dây cắm thẳng PC để cài đặt (không Internet) thì không bao giờ cướp đường của Wi-Fi; dây vào switch có Internet
  //   → tự lên dây (ổn định hơn). Dây đang dùng mà thử hỏng 3 lần liền → về Wi-Fi. Chỉ một cổng có mạng → dùng cổng đó.
  //   Sự cố 2026-11-27: Ethernet cắm PC được chọn làm đường chính (MQTT cũ vẫn đi Wi-Fi nên tưởng dây ổn) → DNS/HTTPS hỏng, mất webapp.
  static int s_pref = 0, s_fails = 0;
  static bool s_ethOk = false;
  static uint32_t s_probeAt = 0;
  uint32_t now = millis();
  int want;
  if (eth && sta) {
    String pref = netPref();
    if (pref == "wifi") want = 2;
    else if (pref == "eth") want = 1;
    else {
      if (!s_probeAt || now - s_probeAt >= (s_ethOk ? 60000UL : 30000UL)) {
        s_probeAt = now ? now : 1;
        bool ok = reachableVia(ETH.localIP());
        if (ok) { s_fails = 0; if (!s_ethOk) { s_ethOk = true; logf("Ethernet ra được Internet — dùng dây làm đường chính"); } }
        else if (s_ethOk && ++s_fails >= 3) { s_ethOk = false; s_fails = 0; logf("Ethernet không còn ra Internet — chuyển về Wi-Fi"); }
        else if (!s_ethOk && s_pref != 2) logf("Ethernet không ra Internet (vd. cắm thẳng PC) — Internet đi Wi-Fi, dây chỉ dùng trong LAN");
      }
      want = s_ethOk ? 1 : 2;
    }
  } else {
    want = eth ? 1 : (sta ? 2 : 0);
    if (!eth || !sta) { s_ethOk = false; s_fails = 0; s_probeAt = 0; }
  }
  static uint32_t s_dnsAt = 0;
  if (eth && (!s_dnsAt || now - s_dnsAt >= 5000)) { s_dnsAt = now; if (!s_dnsAt) s_dnsAt = 1; ethDnsSync(); }   // DNS Ethernet theo DNS của mạng (DHCP Wi-Fi gia hạn/đổi)
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
