// Cài đặt Wi-Fi qua CÁP USB (cổng COM): PC giữ nguyên mạng, không phải nối vào hotspot của board.
// Giao thức: mỗi lệnh là MỘT dòng JSON kết thúc bằng '\n' gửi tới board; board trả MỘT dòng bắt đầu bằng "@@" rồi JSON (các dòng log khác không có "@@").
//   {"cmd":"info"}                              → @@{"Ok":true,"Version","Hw","Mac","Wifi":{…}}
//   {"cmd":"wifi.scan"}                         → @@{"Ok":true,"Nets":[{Ssid,Rssi,Open}]}
//   {"cmd":"wifi.status"}                       → @@{"Ok":true,"Wifi":{…}}
//   {"cmd":"wifi.set","Ssid":"..","Password":".."} → @@{"Ok":true,"Wifi":{…}}  hoặc  @@{"Ok":false,"Err":"wifi_auth_failed"}   (Ssid rỗng = quên mạng)
// An toàn: cắm được cáp USB vào board = có quyền vật lý (nạp lại firmware cũng làm được), nên không cần đăng nhập. Mật khẩu không bao giờ được in ra log.
#include "gw.h"
#include "board.h"
#include <ArduinoJson.h>

#ifndef GW_SIM
namespace {
String s_line;

void reply(JsonDocument& d) {
  String s; serializeJson(d, s);
  Serial.print("@@"); Serial.println(s);
}

void handle(const String& line) {
  JsonDocument q, r;
  if (deserializeJson(q, line)) { r["Ok"] = false; r["Err"] = "bad_json"; reply(r); return; }
  String cmd = q["cmd"] | "";
  if (cmd == "info") {
    r["Ok"] = true; r["Version"] = FW_VERSION; r["Hw"] = idHw();
    { static const char* const kP[] = BOARD_PROTOCOLS; JsonArray pr = r["Protocols"].to<JsonArray>(); for (const char* p : kP) pr.add(p); }
    deserializeJson(r["Wifi"].to<JsonVariant>(), wifiStatusJson());
  } else if (cmd == "wifi.scan") {
    r["Ok"] = true; deserializeJson(r["Nets"].to<JsonVariant>(), wifiScanJson());
  } else if (cmd == "wifi.status") {
    r["Ok"] = true; deserializeJson(r["Wifi"].to<JsonVariant>(), wifiStatusJson());
  } else if (cmd == "wifi.set") {
    String ssid = q["Ssid"] | "", pass = q["Password"] | "", e;
    if (wifiConnect(ssid, pass, e)) { r["Ok"] = true; deserializeJson(r["Wifi"].to<JsonVariant>(), wifiStatusJson()); }
    else { r["Ok"] = false; r["Err"] = e; }
  } else { r["Ok"] = false; r["Err"] = "unknown_cmd"; }
  reply(r);
}
}  // namespace

void serialCfgLoop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { String l = s_line; s_line = ""; l.trim(); if (l.length() && l[0] == '{') handle(l); continue; }
    if (s_line.length() < 512) s_line += c; else s_line = "";   // dòng quá dài: bỏ
  }
}
#else
void serialCfgLoop() {}
#endif
