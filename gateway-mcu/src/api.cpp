// API LAN cho GatewayApp — cùng hợp đồng với gateway PC (tools/GatewayApp/Remote/RemoteApi.cs, Contract.cs, MainForm.Remote.cs):
//   POST /api/login {Code} → {Ok,Token}; mọi yêu cầu sau gửi "Authorization: Bearer <Token>".
//   GET /api/state · GET /api/config · PUT /api/config · POST /api/write · /api/run · /api/device · /api/cloud
// Tìm thiết bị: UDP 8751 nhận "PLCIOT-DISCOVER" → trả ApiHello {Kind:"mcu",Name,Hw,Port,Version}.
// Khác gateway PC: board không có màn hình để hiện mã đổi mỗi phút, nên mã kết nối 8 số CỐ ĐỊNH (in ra cổng USB lúc khởi động,
// dán tem lúc xuất xưởng) và CHỈ dùng được trong "cửa sổ cài đặt": 10 phút sau khi cấp điện, hoặc 10 phút sau khi nhấn BOOT.
// Như vậy muốn cài đặt phải có mặt cạnh board (cấp điện lại / nhấn nút). Phiên đã đăng nhập vẫn dùng tiếp khi cửa sổ đóng.
#include "gw.h"
#include "board.h"
#include <ETH.h>
#include <WebServer.h>
#include <NetworkUdp.h>
#include <esp_random.h>

namespace {
WebServer s_http(API_PORT);
NetworkUDP s_udp;
String s_code;
uint32_t s_windowUntil = 0;
struct Session { String token; uint32_t last; };
std::vector<Session> s_sessions;
int s_fails = 0; uint32_t s_failStart = 0;
bool s_started = false;
const uint32_t kSessionIdleMs = 30 * 60 * 1000UL;

void send(int status, const String& json) { s_http.send(status, "application/json; charset=utf-8", json); }
void ok() { send(200, String("{\"Ok\":true,\"Running\":") + (g_running ? "true" : "false") + "}"); }
void err(const String& e, int status = 400) {
  JsonDocument d; d["Ok"] = false; d["Err"] = e; d["Running"] = g_running;
  String s; serializeJson(d, s); send(status, s);
}

bool windowOpen() { return (int32_t)(s_windowUntil - millis()) > 0; }

bool authed() {
  String a = s_http.header("Authorization");
  if (!a.startsWith("Bearer ")) return false;
  String t = a.substring(7); t.trim();
  uint32_t now = millis();
  for (auto it = s_sessions.begin(); it != s_sessions.end();) {
    if (now - it->last > kSessionIdleMs) { it = s_sessions.erase(it); continue; }
    if (it->token.length() == t.length() && it->token == t) { it->last = now; return true; }
    ++it;
  }
  return false;
}

bool body(JsonDocument& d) {
  if (deserializeJson(d, s_http.arg("plain"))) { err("bad_json"); return false; }
  return true;
}

// ---------------------------------------------------------------- handlers
void hLogin() {
  uint32_t now = millis();
  if (s_fails >= 5 && now - s_failStart < 60000) { send(429, "{\"ok\":false,\"err\":\"too_many_attempts\"}"); return; }
  JsonDocument d; deserializeJson(d, s_http.arg("plain"));
  String code = (d["Code"].isNull() ? d["code"] : d["Code"]) | "";
  code.trim();
  // so sánh thời gian hằng (không lộ số ký tự đúng qua thời gian trả lời)
  bool match = code.length() == s_code.length();
  uint8_t diff = 0; for (size_t i = 0; i < s_code.length(); i++) diff |= (i < code.length() ? code[i] : 0) ^ s_code[i];
  match = match && diff == 0;
  if (!match || !windowOpen()) {
    if (now - s_failStart >= 60000) { s_fails = 0; s_failStart = now; }
    s_fails++;
    send(401, windowOpen() ? "{\"ok\":false,\"err\":\"unauthorized\"}" : "{\"ok\":false,\"err\":\"press_boot\"}");
    return;
  }
  uint8_t r[16]; esp_fill_random(r, 16);
  char hex[33]; for (int i = 0; i < 16; i++) sprintf(hex + i * 2, "%02X", r[i]);
  if (s_sessions.size() >= 4) s_sessions.erase(s_sessions.begin());   // tối đa 4 phiên: bỏ phiên cũ nhất
  s_sessions.push_back({hex, now});
  logf("Admin đăng nhập từ %s", s_http.client().remoteIP().toString().c_str());
  send(200, String("{\"Ok\":true,\"Token\":\"") + hex + "\"}");
}

void hState() {
  JsonDocument d;
  d["Running"] = g_running; d["Status"] = g_running ? g_status : String("đã dừng");
  d["Cloud"] = cloudStateName(); d["Rev"] = g_rev; d["Customer"] = true; d["Fingerprint"] = fingerprint();
  engineValues(d["Values"].to<JsonObject>());
  String s; serializeJson(d, s); send(200, s);
}

void hGetConfig() {
  String s;
  { Lock l; g_raw["Config"]["CloudPassword"] = ""; serializeJson(g_raw, s); }
  send(200, s);
}

void applyChange(const char* why) {
  storeSave(); storeApply(); engineRestart(); cloudRestart();
  g_rev++;
  logf("%s (rev %d)", why, g_rev);
}

void hPutConfig() {
  JsonDocument in;
  if (!body(in)) return;
  JsonObject c = in["Config"];
  if (c.isNull()) { err("bad_request"); return; }
  String e = storeValidate(c);
  if (e.length()) { err(e); return; }
  String pw = c["CloudPassword"] | "";
  if (pw.length()) setCloudPassword(pw);           // để trống = giữ mật khẩu hiện có
  c["CloudPassword"] = "";
  c.remove("GatewayKey");
  { Lock l; g_raw.set(in); if (!g_raw["Fields"].is<JsonObject>()) g_raw["Fields"].to<JsonObject>(); if (!g_raw["Devices"].is<JsonObject>()) g_raw["Devices"].to<JsonObject>(); }
  applyChange("Quản trị viên đã cập nhật cấu hình gateway");
  ok();
}

void hWrite() {
  JsonDocument d; if (!body(d)) return;
  String child = d["Child"] | "", field = d["Field"] | "";
  if (!child.length() || !field.length() || !d["Value"].is<double>()) { err("bad_request"); return; }
  String e = engineWrite(child, field, d["Value"].as<double>(), false);
  if (e.length()) err(e); else ok();
}

void hRun() {
  JsonDocument d; if (!body(d)) return;
  g_running = d["Run"] | true;
  logf(g_running ? "Gateway chạy" : "Gateway tạm dừng (admin)");
  engineRestart();
  ok();
}

void hDevice() {
  JsonDocument d; if (!body(d)) return;
  String child = d["Child"] | ""; bool en = d["Enabled"] | true;
  if (!child.length()) { err("bad_request"); return; }
  int n = 0;
  { Lock l; for (JsonObject p : g_raw["Config"]["Pack"].as<JsonArray>()) if (child == (p["Child"] | "")) { p["Enabled"] = en; n++; } }
  if (!n) { err("không có thiết bị này"); return; }
  applyChange(en ? "Thiết bị chạy lại" : "Thiết bị tạm dừng");
  ok();
}

void hCloud() {
  JsonDocument d; if (!body(d)) return;
  String action = d["Action"] | "", api = d["Api"] | "", value = d["Value"] | "";
  if (!action.length()) { err("bad_request"); return; }
  String msg;
  bool r = cloudAction(action, api, value, msg);
  if (r) g_rev++;
  JsonDocument o; o["Ok"] = r; if (!r) o["Err"] = msg; o["Msg"] = msg; o["Running"] = g_running;
  String s; serializeJson(o, s); send(200, s);
}

/// Trang trạng thái tối giản (không lộ mã kết nối hay bí mật): để kỹ thuật viên kiểm tra nhanh bằng trình duyệt.
void hRoot() {
  String h = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Gateway Waveshare</title>"
             "<body style='font-family:sans-serif;max-width:560px;margin:24px auto;padding:0 16px'><h2>Gateway Waveshare</h2><table>";
  auto row = [&](const char* k, const String& v) { h += "<tr><td style='color:#666;padding-right:16px'>"; h += k; h += "</td><td>" + v + "</td></tr>"; };
  row("Thiết bị", g_cfg.site + "/" + g_cfg.device);
  row("Trạng thái", g_running ? g_status : String("đã dừng"));
  row("Cloud", cloudStateName());
  row("Số field", String(g_cfg.pack.size()));
  row("Mã phần cứng", idHw());
  row("Vân tay", fingerprint());
  row("Phiên bản", FW_VERSION);
  row("Cài đặt", windowOpen() ? "đang mở cho admin (nhập mã kết nối trong GatewayApp)" : "đã đóng — nhấn nút BOOT trên board để mở 10 phút");
  h += "</table><p style='color:#666'>Cài đặt bằng GatewayApp → \"Kết nối Waveshare (LAN)\".</p>";
  s_http.send(200, "text/html; charset=utf-8", h);
}

// (không đặt tên tham số là F: trùng macro F("…") của Arduino)
template <void (*Handler)()> void guarded() { if (!authed()) { send(401, "{\"ok\":false,\"err\":\"unauthorized\"}"); return; } Handler(); }

void udpLoop() {
  int n = s_udp.parsePacket();
  if (n <= 0) return;
  char buf[32] = {0};
  int len = s_udp.read(buf, sizeof buf - 1);
  if (len != 15 || strncmp(buf, "PLCIOT-DISCOVER", 15) != 0) return;
  JsonDocument d;
  d["Kind"] = "mcu"; d["Name"] = g_cfg.mqttId.length() ? g_cfg.site + "/" + g_cfg.device : g_cfg.device;
  d["Hw"] = idHw(); d["Port"] = API_PORT; d["Version"] = FW_VERSION;
  String s; serializeJson(d, s);
  s_udp.beginPacket(s_udp.remoteIP(), s_udp.remotePort());
  s_udp.print(s);
  s_udp.endPacket();
}
}  // namespace

String apiCode() { return s_code; }

void apiOpenWindow(uint32_t ms) {
  s_windowUntil = millis() + ms;
  logf("Mở cho admin cài đặt %lu phút — mã kết nối: %s — IP %s:%d", (unsigned long)(ms / 60000), s_code.c_str(), ETH.localIP().toString().c_str(), API_PORT);
}

void apiBegin() {
  s_code = secretGet("api_code");
  if (s_code.length() != 8) {
    s_code = String(10000000 + esp_random() % 90000000);
    secretSet("api_code", s_code);
  }
  const char* hdrs[] = {"Authorization"};
  s_http.collectHeaders(hdrs, 1);
  s_http.on("/", HTTP_GET, hRoot);
  s_http.on("/api/login", HTTP_POST, hLogin);
  s_http.on("/api/state", HTTP_GET, guarded<hState>);
  s_http.on("/api/config", HTTP_GET, guarded<hGetConfig>);
  s_http.on("/api/config", HTTP_PUT, guarded<hPutConfig>);
  s_http.on("/api/write", HTTP_POST, guarded<hWrite>);
  s_http.on("/api/run", HTTP_POST, guarded<hRun>);
  s_http.on("/api/device", HTTP_POST, guarded<hDevice>);
  s_http.on("/api/cloud", HTTP_POST, guarded<hCloud>);
  s_http.onNotFound([] { err("not_found", 404); });
  apiOpenWindow(10 * 60 * 1000UL);   // vừa cấp điện = đang có người ở cạnh board
}

void apiLoop() {
  if (!s_started) {
    if (ETH.localIP() == IPAddress(0, 0, 0, 0)) return;   // chờ có IP mới mở cổng
    s_http.begin(); s_udp.begin(DISCOVER_PORT); s_started = true;
    logf("API LAN: http://%s:%d — tìm thiết bị UDP %d", ETH.localIP().toString().c_str(), API_PORT, DISCOVER_PORT);
  }
  s_http.handleClient();
  udpLoop();
}
