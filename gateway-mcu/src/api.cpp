// API cài đặt cho GatewayApp — cùng hợp đồng JSON với gateway PC (tools/GatewayApp/Remote/Contract.cs), nhưng qua KÊNH BẢO MẬT:
//   HTTPS cổng 443, chứng chỉ tự ký từ khoá danh tính của board; GatewayApp ghim khoá (dấu nhận dạng = mã phần cứng idHw).
//   Cổng 80 (HTTP thường) chỉ có trang trạng thái — mọi /api/* trả "use_https".
// Không có mã/mật khẩu cho người dùng nhớ. Admin xác thực bằng KHOÁ CỦA PC (GatewayIdentity của GatewayApp):
//   GET  /api/challenge                 → {Nonce, Hw}           (thử thách ngẫu nhiên, dùng một lần, 60 giây; không cần đồng hồ)
//   POST /api/login {Pubkey,Nonce,Sig,Name[,WebToken]}          Sig = ký "admin-login|<Hw board>|<Nonce>" bằng khoá PC
//        PC đã ghép → vào ngay, bất cứ lúc nào (kể cả board OFFLINE hoàn toàn)
//        chưa ghép → ghép nếu: đang trong CỬA SỔ CÀI ĐẶT (10 phút sau cấp điện / nhấn BOOT — có mặt cạnh board, chạy được offline)
//                              hoặc có WebToken (đăng nhập webapp, OTP) và server xác nhận tài khoản đó sở hữu board (cần Internet)
//        còn lại → 403 not_paired
//   → {Ok, Token, Paired}; mọi yêu cầu sau gửi "Authorization: Bearer <Token>".
//   GET /api/state · GET/PUT /api/config · POST /api/write · /api/run · /api/device · /api/cloud · GET/PUT /api/network
// Tìm thiết bị: UDP 8751 "PLCIOT-DISCOVER" → ApiHello {Kind:"mcu",Name,Hw,Port:443,Tls:true,Ip,Mask,Mac,Version}
//   (trả cả broadcast: khác mạng con vẫn thấy). Giữ BOOT 10 giây = reset: xoá danh sách PC đã ghép.
#include "gw.h"
#include "board.h"
#include "https.h"
#include <ETH.h>
#include <NetworkUdp.h>
#include <esp_random.h>

namespace {
HttpServer s_https(API_PORT, true);
HttpServer s_http(STATUS_PORT, false);
NetworkUDP s_udp;
uint32_t s_windowUntil = 0;
struct Session { String token; uint32_t last; String pk; };
std::vector<Session> s_sessions;
struct Nonce { String v; uint32_t at; };
std::vector<Nonce> s_nonces;
int s_fails = 0; uint32_t s_failStart = 0;
bool s_started = false;
uint32_t s_restartAt = 0;   // đổi IP: trả lời xong mới khởi động lại
const uint32_t kSessionIdleMs = 30 * 60 * 1000UL;
const size_t kMaxAdmins = 8;

// yêu cầu/trả lời đang xử lý (một kết nối mỗi lúc)
const HttpRequest* q_ = nullptr;
HttpResponse* r_ = nullptr;

void send(int status, const String& json) { r_->json(status, json); }
void ok() { send(200, String("{\"Ok\":true,\"Running\":") + (g_running ? "true" : "false") + "}"); }
void err(const String& e, int status = 400) {
  JsonDocument d; d["Ok"] = false; d["Err"] = e; d["Running"] = g_running;
  String s; serializeJson(d, s); send(status, s);
}
bool body(JsonDocument& d) { if (deserializeJson(d, q_->body)) { err("bad_json"); return false; } return true; }
bool windowOpen() { return (int32_t)(s_windowUntil - millis()) > 0; }
String hex(const uint8_t* p, size_t n) { String s; char b[3]; for (size_t i = 0; i < n; i++) { sprintf(b, "%02X", p[i]); s += b; } return s; }

String s_sessionPk;   // khoá PC của phiên đang xử lý (authed() đặt)
bool authed() {
  String a = q_->auth;
  if (!a.startsWith("Bearer ")) return false;
  String t = a.substring(7); t.trim();
  uint32_t now = millis();
  for (auto it = s_sessions.begin(); it != s_sessions.end();) {
    if (now - it->last > kSessionIdleMs) { it = s_sessions.erase(it); continue; }
    if (it->token.length() == t.length() && it->token == t) { it->last = now; s_sessionPk = it->pk; return true; }
    ++it;
  }
  return false;
}

// ---------------------------------------------------------------- PC quản trị (NVS "admins"): [{Pk,Name,How,Active,Waited}]
// Quy tắc (như chuyển chủ gateway trên server): board chưa có PC quản trị → ghép là dùng ngay (cài mới / vừa reset).
// Đã có PC quản trị → PC mới ghép bằng BOOT ở trạng thái CHỜ: PC quản trị cũ đồng ý (ngay) hoặc từ chối; không ai từ chối thì
// tự kích hoạt sau 24 giờ board có điện (Waited, cộng dồn qua các lần khởi động). Chủ board xác nhận bằng webapp → kích hoạt ngay.
JsonDocument loadAdmins() { JsonDocument d; if (deserializeJson(d, secretGet("admins")) || !d.is<JsonArray>()) d.to<JsonArray>(); return d; }
void saveAdmins(JsonDocument& d) { String s; serializeJson(d, s); secretSet("admins", s); }
int activeAdmins() { int n = 0; JsonDocument d = loadAdmins(); for (JsonObject a : d.as<JsonArray>()) if (a["Active"] | true) n++; return n; }
String adminId(const String& pk) { return sha256Hex((const uint8_t*)pk.c_str(), pk.length()).substring(0, 12); }

/// Trạng thái PC theo khoá: 0 = chưa ghép, 1 = đang chờ, 2 = đang dùng. Chờ đủ 24 giờ → tự chuyển sang dùng (lưu lại).
int adminState(const String& pk, uint32_t* remainMin = nullptr) {
  JsonDocument d = loadAdmins();
  for (JsonObject a : d.as<JsonArray>()) {
    if (pk != (a["Pk"] | "")) continue;
    if (a["Active"] | true) return 2;
    uint32_t waited = a["Waited"] | 0u;
    if (waited >= PAIR_WAIT_MS) { a["Active"] = true; saveAdmins(d); logf("PC \"%s\" chờ đủ 24 giờ không ai từ chối — đã kích hoạt", (const char*)(a["Name"] | "")); return 2; }
    if (remainMin) *remainMin = (PAIR_WAIT_MS - waited) / 60000 + 1;
    return 1;
  }
  return 0;
}

void addAdmin(const String& pk, const String& name, const char* how, bool active) {
  JsonDocument d = loadAdmins(); JsonArray arr = d.as<JsonArray>();
  for (size_t i = 0; i < arr.size(); i++) if (pk == (arr[i]["Pk"] | "")) { arr.remove(i); break; }
  while (arr.size() >= kMaxAdmins) arr.remove(0);   // đầy: bỏ PC ghép lâu nhất
  JsonObject a = arr.add<JsonObject>(); a["Pk"] = pk; a["Name"] = name; a["How"] = how; a["Active"] = active; a["Waited"] = 0;
  saveAdmins(d);
  logf(active ? "Đã ghép PC quản trị \"%s\" (%s) — từ nay vào thẳng" : "PC \"%s\" (%s) xin ghép — chờ PC quản trị cũ đồng ý/từ chối, hoặc tự kích hoạt sau 24 giờ", name.c_str(), how);
  if (!active) ioBeep(150);
}

/// Cộng thời gian chờ cho PC đang chờ (gọi trong apiLoop). Ghi NVS mỗi 10 phút để không mòn flash; mất điện thì mất tối đa 10 phút đếm.
void tickPending() {
  static uint32_t last = millis(), unsaved = 0;
  uint32_t now = millis(), dt = now - last;
  if (dt < 1000) return;
  last = now; unsaved += dt;
  if (unsaved < (PAIR_WAIT_MS < 3600000UL ? 1000UL : 600000UL)) return;   // bản giả lập rút ngắn 24 giờ: ghi mỗi giây
  JsonDocument d = loadAdmins(); bool any = false;
  for (JsonObject a : d.as<JsonArray>()) if (!(a["Active"] | true)) { a["Waited"] = (uint32_t)(a["Waited"] | 0u) + unsaved; any = true; }
  if (any) saveAdmins(d);
  unsaved = 0;
}

// ---------------------------------------------------------------- handlers
void hChallenge() {
  uint8_t r[16]; esp_fill_random(r, sizeof r);
  uint32_t now = millis();
  for (auto it = s_nonces.begin(); it != s_nonces.end();) { if (now - it->at > 60000) it = s_nonces.erase(it); else ++it; }
  if (s_nonces.size() >= 8) s_nonces.erase(s_nonces.begin());
  s_nonces.push_back({hex(r, sizeof r), now});
  JsonDocument d; d["Nonce"] = s_nonces.back().v; d["Hw"] = idHw(); d["Window"] = windowOpen();
  String s; serializeJson(d, s); send(200, s);
}

void hLogin() {
  uint32_t now = millis();
  if (s_fails >= 5 && now - s_failStart < 60000) { err("too_many_attempts", 429); return; }
  auto fail = [&](const char* e, int code) { if (now - s_failStart >= 60000) { s_fails = 0; s_failStart = now; } s_fails++; err(e, code); };
  JsonDocument d; if (!body(d)) return;
  String pk = d["Pubkey"] | "", nonce = d["Nonce"] | "", sig = d["Sig"] | "", name = d["Name"] | "", web = d["WebToken"] | "";
  bool fresh = false;
  for (auto it = s_nonces.begin(); it != s_nonces.end(); ++it) if (it->v == nonce && now - it->at <= 60000) { s_nonces.erase(it); fresh = true; break; }
  if (!fresh) { fail("bad_nonce", 401); return; }   // thử thách dùng một lần: chặn phát lại
  if (!verifySig(pk, "admin-login|" + idHw() + "|" + nonce, sig)) { fail("bad_signature", 401); return; }
  uint32_t remain = 0;
  int st = adminState(pk, &remain);
  bool newly = false;
  String why;
  if (st != 2 && web.length() && cloudOwnsBoard(web, why)) { addAdmin(pk, name, "webapp", true); newly = true; st = 2; }   // chủ board xác nhận: dùng ngay
  if (st == 0) {
    if (windowOpen()) {
      bool first = activeAdmins() == 0;   // chưa có PC quản trị (mới / vừa reset): dùng ngay
      addAdmin(pk, name, "BOOT", first);
      if (first) { newly = true; st = 2; } else { st = 1; remain = PAIR_WAIT_MS / 60000; }
    } else { err(web.length() ? (why.length() ? why : String("not_owner")) : String("not_paired"), 403); return; }
  }
  if (st == 1) {   // đang chờ: PC quản trị cũ đồng ý, chủ board xác nhận webapp, hoặc hết 24 giờ
    JsonDocument o; o["Ok"] = false; o["Err"] = "pair_pending"; o["RemainMin"] = remain; o["Running"] = g_running;
    String s; serializeJson(o, s); send(403, s); return;
  }
  uint8_t r[16]; esp_fill_random(r, sizeof r);
  if (s_sessions.size() >= 4) s_sessions.erase(s_sessions.begin());   // tối đa 4 phiên
  s_sessions.push_back({hex(r, sizeof r), now, pk});
  logf("Admin \"%s\" đăng nhập từ %s (HTTPS)", name.c_str(), q_->ip.toString().c_str());
  JsonDocument o; o["Ok"] = true; o["Token"] = s_sessions.back().token; o["Paired"] = newly;
  String s; serializeJson(o, s); send(200, s);
}

void hAdmins() {
  JsonDocument d = loadAdmins(), o; JsonArray out = o.to<JsonArray>();
  for (JsonObject a : d.as<JsonArray>()) {
    String pk = a["Pk"] | ""; bool act = a["Active"] | true; uint32_t w = a["Waited"] | 0u;
    JsonObject x = out.add<JsonObject>();
    x["Id"] = adminId(pk); x["Name"] = a["Name"] | ""; x["How"] = a["How"] | ""; x["Active"] = act;
    x["RemainMin"] = act ? 0u : (w >= PAIR_WAIT_MS ? 0u : (PAIR_WAIT_MS - w) / 60000 + 1); x["Self"] = pk == s_sessionPk;
  }
  String s; serializeJson(o, s); send(200, s);
}

/// PC quản trị đang dùng: đồng ý (kích hoạt ngay) / từ chối PC đang chờ, hoặc gỡ một PC (không gỡ được PC quản trị cuối cùng).
void hAdminAction() {
  JsonDocument d; if (!body(d)) return;
  String id = d["Id"] | "", action = d["Action"] | "";
  JsonDocument all = loadAdmins(); JsonArray arr = all.as<JsonArray>();
  for (size_t i = 0; i < arr.size(); i++) {
    String pk = arr[i]["Pk"] | "";
    if (adminId(pk) != id) continue;
    String name = arr[i]["Name"] | "";
    if (action == "approve") { arr[i]["Active"] = true; saveAdmins(all); logf("Đã đồng ý PC \"%s\"", name.c_str()); ok(); return; }
    if (action == "reject" || action == "remove") {
      bool act = arr[i]["Active"] | true;
      if (act && activeAdmins() <= 1) { err("Không gỡ được PC quản trị cuối cùng (giữ BOOT 10 giây để reset board nếu cần)."); return; }
      arr.remove(i); saveAdmins(all);
      for (auto it = s_sessions.begin(); it != s_sessions.end();) { if (it->pk == pk) it = s_sessions.erase(it); else ++it; }
      logf(action == "reject" ? "Đã từ chối PC \"%s\"" : "Đã gỡ PC \"%s\"", name.c_str()); ok(); return;
    }
    err("bad_request"); return;
  }
  err("không có PC này", 404);
}

void hState() {
  JsonDocument d;
  d["Running"] = g_running; d["Status"] = g_running ? g_status : String("đã dừng");
  d["Mode"] = leaseActive() ? "gateway" : "standalone"; if (leaseActive()) d["LeaseHolder"] = leaseHolder().toString();
  d["Cloud"] = cloudStateName(); d["Rev"] = g_rev; d["Customer"] = true; d["Fingerprint"] = fingerprint();
  engineValues(d["Values"].to<JsonObject>());
  String s; serializeJson(d, s); send(200, s);
}

void hGetConfig() {
  String s;
  { Lock l; g_raw["Config"]["CloudPassword"] = ""; serializeJson(g_raw, s); }
  send(200, s);
}

/// Bản tin <base>/config đúng như board sẽ publish lên cloud (chỉ đọc): để GatewayApp xem trước / kiểm thử cặp lệnh ↔ phản hồi (fb).
void hConfigMessage() { send(200, configMessage()); }

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

/// Lease chế độ gateway: {Action:"acquire"|"release", TtlSec} — PC đang giữ gia hạn bằng nhịp tim (mỗi vài giây); PC khác bị từ chối (lease_held).
void hLease() {
  JsonDocument d; if (!body(d)) return;
  String action = d["Action"] | "acquire";
  if (action == "release") { if (leaseActive() && leaseHolder() == q_->ip) leaseRelease(); }
  else if (action == "acquire") {
    if (leaseActive() && leaseHolder() != q_->ip) { err("lease_held", 409); return; }
    int ttl = d["TtlSec"] | 15; ttl = ttl < 5 ? 5 : ttl > 120 ? 120 : ttl;
    leaseSet(q_->ip, (uint32_t)ttl * 1000);
  } else { err("bad_request"); return; }
  JsonDocument o; o["Ok"] = true; o["Running"] = g_running; o["Mode"] = leaseActive() ? "gateway" : "standalone";
  o["TtlMs"] = leaseRemainingMs(); o["Port"] = MBS_PORT;
  String s; serializeJson(o, s); send(200, s);
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

void hGetNetwork() {
  NetCfg n = netLoad();
  JsonDocument d;
  d["Dhcp"] = n.dhcp; d["Ip"] = n.ip; d["Mask"] = n.mask; d["Gateway"] = n.gw; d["Dns"] = n.dns;
  d["Mac"] = ETH.macAddress(); d["Current"] = ETH.localIP().toString();
  String s; serializeJson(d, s); send(200, s);
}

/// Đổi IP: kiểm tra → lưu NVS → trả lời → khởi động lại sau 1,5 giây (admin nối lại bằng IP mới; PC đã ghép nên không cần BOOT).
void hPutNetwork() {
  JsonDocument d; if (!body(d)) return;
  NetCfg n = netLoad();
  n.dhcp = d["Dhcp"] | false;
  if (!n.dhcp) {
    n.ip = String(d["Ip"] | ""); n.mask = String(d["Mask"] | NET_DEFAULT_MASK); n.gw = String(d["Gateway"] | ""); n.dns = String(d["Dns"] | NET_DEFAULT_DNS);
    n.ip.trim(); n.mask.trim(); n.gw.trim(); n.dns.trim();
  }
  String e = netValidate(n);
  if (e.length()) { err(e); return; }
  netSave(n);
  logf("Admin đổi mạng: %s — khởi động lại", n.dhcp ? "DHCP" : (n.ip + "/" + n.mask + " gw " + n.gw).c_str());
  s_restartAt = millis() + 1500;
  JsonDocument o; o["Ok"] = true; o["Running"] = g_running; o["Msg"] = n.dhcp ? String("Board khởi động lại và xin IP bằng DHCP.") : "Board khởi động lại với IP " + n.ip + ".";
  String s; serializeJson(o, s); send(200, s);
}

/// Trang trạng thái (cổng 80 và 443) — không lộ bí mật: để kỹ thuật viên kiểm tra nhanh bằng trình duyệt.
void hRoot() {
  String h = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Gateway Waveshare</title>"
             "<body style='font-family:sans-serif;max-width:560px;margin:24px auto;padding:0 16px'><h2>Gateway Waveshare</h2><table>";
  auto row = [&](const char* k, const String& v) { h += "<tr><td style='color:#666;padding-right:16px'>"; h += k; h += "</td><td>" + v + "</td></tr>"; };
  if (g_locked) row("⚠ TRẠNG THÁI", "<b style='color:#c00'>THIẾT BỊ BỊ KHOÁ</b> — đã báo mất. Liên hệ nhà cung cấp.");
  row("Thiết bị", g_cfg.site + "/" + g_cfg.device);
  row("Trạng thái", g_running ? g_status : String("đã dừng"));
  row("Cloud", cloudStateName());
  row("Số field", String(g_cfg.pack.size()));
  { NetCfg n = netLoad(); row("Mạng", n.dhcp ? "DHCP — đang dùng " + ETH.localIP().toString() : "IP tĩnh " + n.ip + " / " + n.mask + ", gateway " + n.gw); }
  row("MAC", ETH.macAddress());
  row("Mã phần cứng", idHw() + " (dấu nhận dạng khi GatewayApp kết nối)");
  { int act = activeAdmins(); int all = loadAdmins().as<JsonArray>().size(); row("PC quản trị", String(act) + " đang dùng" + (all > act ? ", " + String(all - act) + " đang chờ" : String(""))); }
  row("Phiên bản", FW_VERSION);
  row("Ghép PC mới", windowOpen() ? "đang mở (GatewayApp → \"Kết nối Waveshare\")" : "nhấn nút BOOT trên board để mở 10 phút, hoặc đăng nhập webapp trong GatewayApp");
  h += "</table><p style='color:#666'>Cài đặt bằng GatewayApp (HTTPS cổng " + String(API_PORT) + ").</p>";
  r_->html(h);
}

struct Route { const char* method; const char* path; void (*fn)(); bool auth; };
const Route kRoutes[] = {
  {"GET", "/", hRoot, false},
  {"GET", "/api/challenge", hChallenge, false}, {"POST", "/api/login", hLogin, false},
  {"GET", "/api/state", hState, true}, {"GET", "/api/config", hGetConfig, true}, {"GET", "/api/config-message", hConfigMessage, true}, {"PUT", "/api/config", hPutConfig, true},
  {"POST", "/api/write", hWrite, true}, {"POST", "/api/lease", hLease, true}, {"POST", "/api/run", hRun, true}, {"POST", "/api/device", hDevice, true},
  {"POST", "/api/cloud", hCloud, true}, {"GET", "/api/admins", hAdmins, true}, {"POST", "/api/admins", hAdminAction, true}, {"GET", "/api/network", hGetNetwork, true}, {"PUT", "/api/network", hPutNetwork, true},
};

void dispatch(const HttpRequest& q, HttpResponse& r) {
  q_ = &q; r_ = &r;
  if (g_locked && q.path != "/") {   // báo mất trộm: không cho ai đăng nhập / cài đặt (kể cả PC đã ghép)
    JsonDocument d; d["Ok"] = false; d["Err"] = "device_locked"; d["Reason"] = g_lockReason;
    String s; serializeJson(d, s); send(423, s); return;
  }
  if (!q.tls && q.path != "/") {   // cổng 80: chỉ trang trạng thái, không nhận lệnh cấu hình qua kênh không mã hoá
    JsonDocument d; d["Ok"] = false; d["Err"] = "use_https"; d["Port"] = API_PORT;
    String s; serializeJson(d, s); send(403, s); return;
  }
  for (auto& rt : kRoutes) {
    if (q.path != rt.path || q.method != rt.method) continue;
    if (rt.auth && !authed()) { err("unauthorized", 401); return; }
    rt.fn(); return;
  }
  err("not_found", 404);
}

void udpLoop() {
  int n = s_udp.parsePacket();
  if (n <= 0) return;
  char buf[32] = {0};
  int len = s_udp.read(buf, sizeof buf - 1);
  if (len != 15 || strncmp(buf, "PLCIOT-DISCOVER", 15) != 0) return;
  JsonDocument d;
  d["Kind"] = "mcu"; d["Name"] = g_cfg.mqttId.length() ? g_cfg.site + "/" + g_cfg.device : g_cfg.device;
  d["Hw"] = idHw(); d["Port"] = API_PORT; d["Tls"] = true; d["Version"] = FW_VERSION; if (g_locked) d["Locked"] = true;
  d["Ip"] = ETH.localIP().toString(); d["Mask"] = netMask(); d["Mac"] = ETH.macAddress();
  String s; serializeJson(d, s);
  // trả lời cả unicast lẫn broadcast (như công cụ cấu hình của Waveshare): máy admin KHÁC mạng con vẫn thấy board để đổi IP
  IPAddress to = s_udp.remoteIP(); uint16_t port = s_udp.remotePort();
  s_udp.beginPacket(to, port); s_udp.print(s); s_udp.endPacket();
  s_udp.beginPacket(IPAddress(255, 255, 255, 255), port); s_udp.print(s); s_udp.endPacket();
}
}  // namespace

void apiOpenWindow(uint32_t ms) {
  if (g_locked) { logf("Thiết bị bị khoá — nút BOOT không mở ghép PC"); return; }
  s_windowUntil = millis() + ms;
  logf("Mở ghép PC admin %lu giây — GatewayApp → \"Kết nối Waveshare\" (HTTPS %s:%d, mã phần cứng %s)",
       (unsigned long)(ms / 1000), ETH.localIP().toString().c_str(), API_PORT, idHw().c_str());
}

void apiForgetAdmins() { secretSet("admins", "[]"); }

void apiBegin() {
  // Cấp điện chỉ mở cửa sổ ghép khi board CHƯA có PC admin nào (mới mua / vừa reset): người lạ rút điện cắm lại không ghép được.
  // Đã có PC ghép: muốn ghép PC mới phải nhấn BOOT (trong tủ điện) hoặc chủ board xác nhận bằng webapp.
  if (activeAdmins() == 0) apiOpenWindow(SETUP_WINDOW_MS);
  else logf("Đã có PC admin ghép — ghép PC mới: nhấn BOOT trên board hoặc đăng nhập webapp của chủ board");
}

void apiLoop() {
  if (!s_started) {
    if (ETH.localIP() == IPAddress(0, 0, 0, 0)) return;   // chờ có IP mới mở cổng
    s_https.begin(); s_http.begin(); s_udp.begin(DISCOVER_PORT); s_started = true;
    logf("Cài đặt: https://%s:%d (trang trạng thái http://%s/) — tìm thiết bị UDP %d",
         ETH.localIP().toString().c_str(), API_PORT, ETH.localIP().toString().c_str(), DISCOVER_PORT);
  }
  s_https.handle(dispatch);
  s_http.handle(dispatch);
  udpLoop();
  tickPending();
  if (s_restartAt && (int32_t)(millis() - s_restartAt) >= 0) { logf("Khởi động lại để áp mạng mới"); delay(100); ESP.restart(); }
}
