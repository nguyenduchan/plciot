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
// Tìm thiết bị: UDP 8751 "PLCIOT-DISCOVER" → ApiHello {Kind:"mcu",Name,Hw,Port:443,Tls:true,Ip,Mask,Mac,Version,Protocols:["dio","rs485"]}
//   (trả cả broadcast: khác mạng con vẫn thấy). Giữ BOOT 10 giây = reset: xoá danh sách PC đã ghép.
#include "gw.h"
#include "board.h"
#include "https.h"
#include <ETH.h>
#include <NetworkUdp.h>
#include <esp_random.h>

namespace {
const char* const kProtocols[] = BOARD_PROTOCOLS;
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
String s_rpcAdm;      // yêu cầu đang xử lý đến từ xa (rpc có chữ ký server, cloud.cpp đã kiểm): tên máy GatewayAdmin; "" = LAN
bool tokenOk(const String& a) {
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
bool authed() { return s_rpcAdm.length() || tokenOk(q_->auth); }

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
  evLog(active ? "pc_paired" : "pc_pair_request", String(active ? "Đã ghép PC quản trị mới \"" : "PC lạ \"") + name + "\" (" + how + ")" + (active ? "" : " xin ghép quản trị"), true);
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
  auto fail = [&](const char* e, int code) {
    if (now - s_failStart >= 60000) { s_fails = 0; s_failStart = now; }
    if (++s_fails == 5) evLog("login_fail", "Đăng nhập quản trị sai 5 lần trong 1 phút từ " + q_->ip.toString() + " — tạm khoá 60 giây", true);
    err(e, code);
  };
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
  // Người cầm board được tin (mô hình: chỉ chống tấn công từ internet): nhấn BOOT (hoặc board mới chưa có PC) → PC này dùng NGAY,
  // không cần gì từ PC cũ (bán/chuyển board). Board ĐANG CÓ CHỦ (PC quản trị khác) → PC lạ = người mới: phải đồng ý XOÁ dữ liệu chủ cũ
  // (Wipe=true; thiếu → wipe_required để GatewayApp hỏi trước) — không lộ cấu hình/nhật ký/chương trình của chủ cũ. Giữ mạng + khoá danh tính.
  bool wiped = false;
  if (st != 2 && windowOpen()) {
    if (activeAdmins() > 0) {
      if (!(d["Wipe"] | false)) { err("wipe_required", 409); return; }
      storeWipeOwner(); wiped = true;
      evLog("owner_wiped", "PC lạ \"" + name + "\" ghép bằng nút BOOT: đã xoá dữ liệu chủ cũ", false);
      s_restartAt = millis() + 1500;   // trả lời xong mới khởi động lại (RAM còn trạng thái của chủ cũ)
    }
    addAdmin(pk, name, "BOOT", true); newly = true; st = 2;
  }
  if (st == 0) { err(web.length() ? (why.length() ? why : String("not_owner")) : String("not_paired"), 403); return; }
  if (st == 1) {   // đang chờ: PC quản trị cũ đồng ý, chủ board xác nhận webapp, hoặc hết 24 giờ
    JsonDocument o; o["Ok"] = false; o["Err"] = "pair_pending"; o["RemainMin"] = remain; o["Running"] = g_running;
    String s; serializeJson(o, s); send(403, s); return;
  }
  uint8_t r[16]; esp_fill_random(r, sizeof r);
  if (s_sessions.size() >= 4) s_sessions.erase(s_sessions.begin());   // tối đa 4 phiên
  s_sessions.push_back({hex(r, sizeof r), now, pk});
  logf("Admin \"%s\" đăng nhập từ %s (HTTPS)", name.c_str(), q_->ip.toString().c_str());
  evLog("pc_login", "PC quản trị \"" + name + "\" đăng nhập từ " + q_->ip.toString());
  JsonDocument o; o["Ok"] = true; o["Token"] = s_sessions.back().token; o["Paired"] = newly; if (wiped) o["Wiped"] = true;
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
  d["DoOk"] = ioDoOk(); d["TimeSource"] = timeSource(); d["BootReason"] = bootReason();   // độ tin cậy khi chạy độc lập (GatewayApp chưa hiện, bỏ qua trường lạ)
  d["SafeMode"] = safeMode(); d["BootFails"] = safetyBootFails();
  engineAges(d["AgeMs"].to<JsonObject>());
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
  if (s_rpcAdm.length()) {
    // GatewayAdmin qua cloud (chủ trạm đã bật "Hỗ trợ từ xa"): sửa được thiết bị/field/chu kỳ… như gateway PC, nhưng GIỮ thông số cloud và
    // danh tính (giống MainForm.Remote.cs fromCloud) — sửa nhầm là cắt luôn kết nối đang dùng, phải ra tủ điện mới cứu được.
    auto pinned = [](const String& k) { return k.startsWith("Cloud") || k == "Site" || k == "Device" || k == "Mobile" || k == "MqttId" || k == "GatewayQr" || k == "Solution"; };
    std::vector<String> drop;
    for (JsonPair kv : c) { String k = kv.key().c_str(); if (pinned(k)) drop.push_back(k); }
    for (auto& k : drop) c.remove(k);   // không xoá trong lúc duyệt
    JsonDocument cur;
    { Lock l; cur.set(g_raw["Config"]); }
    for (JsonPair kv : cur.as<JsonObject>()) { String k = kv.key().c_str(); if (pinned(k)) c[k] = kv.value(); }
    c["CloudPassword"] = "";   // để trống = giữ mật khẩu MQTT hiện có
  }
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
    // thời gian tối thiểu giữa hai lần đổi trạng thái DO1..DO8 theo cấu hình gateway PC (BoardLease.DoMinMs); không gửi = giữ giá trị cũ
    JsonArrayConst dm = d["DoMinMs"].as<JsonArrayConst>();
    if (!dm.isNull()) { uint32_t ms[8] = {0}; int i = 0; for (JsonVariantConst v : dm) { if (i >= 8) break; long x = v | 0L; ms[i++] = (uint32_t)constrain(x, 0L, 3600000L); } ioDoMinLease(ms); }
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
  d["Mac"] = ETH.macAddress(); d["Current"] = netIp().toString(); d["Pref"] = netPref();
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
  String pref = String(d["Pref"] | "");   // đường ra Internet ưu tiên (tuỳ chọn): auto | wifi | eth
  if (pref.length() && pref != "auto" && pref != "wifi" && pref != "eth") { err("Đường ưu tiên phải là auto, wifi hoặc eth."); return; }
  String e = netValidate(n);
  if (e.length()) { err(e); return; }
  netSave(n);
  if (pref.length()) secretSet("net_pref", pref);
  logf("Admin đổi mạng: %s — khởi động lại", n.dhcp ? "DHCP" : (n.ip + "/" + n.mask + " gw " + n.gw).c_str());
  s_restartAt = millis() + 1500;
  JsonDocument o; o["Ok"] = true; o["Running"] = g_running; o["Msg"] = n.dhcp ? String("Board khởi động lại và xin IP bằng DHCP.") : "Board khởi động lại với IP " + n.ip + ".";
  String s; serializeJson(o, s); send(200, s);
}


/// Cập nhật firmware qua mạng: POST /api/ota, thân = firmware.bin thô, header X-Sha256 = SHA-256 (hex) của file.
/// Chỉ PC admin đã đăng nhập (kênh HTTPS đã ghim khoá). Ghi vào phân vùng OTA kia, kiểm SHA-256 rồi mới đổi phân vùng khởi động và khởi động lại;
/// hỏng giữa chừng (đứt mạng, sai SHA) → bản đang chạy giữ nguyên. Lease/khoá cấu hình không đổi.
void hOta() {
  if (!q_->readBody || !q_->contentLen) { err("bad_request"); return; }   // bản giả lập: ghi ra SIM_DATA/ota-new.bin (sim/include/Update.h)
  // chìa khoá 2 lớp: chữ ký nhà phát triển (X-Fw-Version + X-Fw-Sig ký "fw1|<sha256>|<phiên bản>") + chủ trạm đã duyệt (board có chủ)
  String e;
  if (!otaStart(q_->contentLen, q_->fwVersion, q_->sha256, q_->fwSig, "LAN " + q_->ip.toString(), e)) {
    // từ chối ngay đầu nhưng PC vẫn đang gửi file: đọc bỏ phần còn lại rồi mới trả lời (không thì PC chỉ thấy "đứt kết nối")
    static uint8_t sink[2048]; size_t left = q_->contentLen; uint32_t t0 = millis();
    while (left && millis() - t0 < 20000) { int n = q_->readBody(sink, min(left, sizeof sink)); if (n < 0) break; if (n == 0) { delay(1); continue; } left -= n; wdtFeed(WD_LOOP); }
    err(e, e == "ota_not_approved" ? 403 : 400); return;
  }
  static uint8_t buf[2048];
  size_t got = 0; uint32_t lastData = millis();
  while (got < q_->contentLen) {
    int n = q_->readBody(buf, sizeof buf);
    if (n < 0) break;
    wdtFeed(WD_LOOP);   // nhận firmware chạy trong loop(): có thể lâu hơn hạn watchdog của loop
    if (n == 0) { if (millis() - lastData > 15000) break; delay(1); continue; }
    lastData = millis();
    if (!otaWrite(buf, n, e)) { err(e); return; }
    got += n;
  }
  if (got != q_->contentLen) { otaAbort(); logf("OTA: đứt giữa chừng (%u/%u)", (unsigned)got, (unsigned)q_->contentLen); err("ota_incomplete"); return; }
  if (!otaFinish(e)) { err(e); return; }
  JsonDocument o; o["Ok"] = true; o["Running"] = g_running; o["Msg"] = "Đã nạp firmware, board khởi động lại (tự quay về bản cũ nếu bản mới không chạy ổn).";
  String s; serializeJson(o, s); send(200, s);
}

/// Wi-Fi: quét mạng, xem trạng thái, nối (mật khẩu chỉ đi vào, không bao giờ trả ra).
void hWifiScan() { send(200, wifiScanJson()); }
void hWifiGet() { send(200, wifiStatusJson()); }
void hWifiPut() {
  JsonDocument d; if (!body(d)) return;
  String ssid = d["Ssid"] | "", pass = d["Password"] | "", e;
  if (!wifiConnect(ssid, pass, e)) { err(e); return; }
  JsonDocument o; deserializeJson(o, wifiStatusJson()); o["Ok"] = true; o["Running"] = g_running;
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
  { NetCfg n = netLoad(); row("Mạng", n.dhcp ? "DHCP — đang dùng " + netIp().toString() : "IP tĩnh " + n.ip + " / " + n.mask + ", gateway " + n.gw); }
  row("MAC", ETH.macAddress());
  row("Mã phần cứng", idHw() + " (dấu nhận dạng khi GatewayApp kết nối)");
  { int act = activeAdmins(); int all = loadAdmins().as<JsonArray>().size(); row("PC quản trị", String(act) + " đang dùng" + (all > act ? ", " + String(all - act) + " đang chờ" : String(""))); }
  row("Phiên bản", FW_VERSION);
  row("Ghép PC mới", windowOpen() ? "đang mở (GatewayApp → \"Kết nối Waveshare\")" : "nhấn nút BOOT trên board để mở 10 phút, hoặc đăng nhập webapp trong GatewayApp");
  h += "</table><p style='color:#666'>Cài đặt bằng GatewayApp (HTTPS cổng " + String(API_PORT) + ").</p>";
  if (mobileEnabled() && !g_locked) {
    String u = "https://" + netIp().toString() + (API_PORT == 443 ? String("") : ":" + String(API_PORT)) + "/m";
    h += "<p><a href='" + u + "' style='display:inline-block;padding:14px 20px;background:#0a7;color:#fff;border-radius:10px;text-decoration:none;font-size:18px'>📱 Cài đặt bằng điện thoại</a></p>"
         "<p style='color:#666;font-size:14px'>Trình duyệt sẽ báo \"kết nối không riêng tư\" (chứng chỉ của board tự ký) → bấm <b>Nâng cao → Tiếp tục</b>. Cần nhấn nút BOOT trên board để đăng nhập.</p>";
  }
  r_->html(h);
}

/// Logic khi mất mạng (offline.cpp): GET = chính sách + trạng thái chạy; PUT {Rev,TzMin,Do:[…]} (Rev khác = người khác vừa sửa → 409);
/// POST /api/offline/test {Sec} = thử mất mạng (0 = dừng).
void hOfflineGet() { JsonDocument d; offlineGet(d); d["Ok"] = true; String s; serializeJson(d, s); send(200, s); }
void hOfflinePut() {
  JsonDocument d; if (!body(d)) return;
  uint32_t rev = 0;
  String e = offlinePut(d.as<JsonObjectConst>(), rev, s_rpcAdm.length() ? "từ xa: " + s_rpcAdm : String("LAN"));
  if (e == "rev_conflict") { err(e, 409); return; }
  if (e.length()) { err(e); return; }
  JsonDocument o; o["Ok"] = true; o["Rev"] = rev; o["Running"] = g_running; String s; serializeJson(o, s); send(200, s);
}
void hOfflineTest() {
  JsonDocument d; if (!body(d)) return;
  long sec = d["Sec"] | 0L;
  if (sec < 0 || sec > 3600) { err("bad_request"); return; }
  offlineTest((uint32_t)sec);
  ok();
}

/// Nhật ký sự kiện (cập nhật, duyệt, quay về bản cũ, ghép/đăng nhập PC…) — 100 dòng mới nhất; trạng thái cập nhật firmware.
void hEvents() { send(200, "{\"Ok\":true,\"Events\":" + evRecent(100) + "}"); }
void hOtaState() { send(200, otaStatusJson()); }
/// Board là slave của gateway PC (không tự lên cloud): gateway PC chuyển tiếp lệnh "cho phép cập nhật" do SERVER ký (xem ota.cpp).
void hOtaNonce() { JsonDocument o; o["Nonce"] = otaNonce(); o["CloudId"] = g_cfg.mqttId; String s; serializeJson(o, s); send(200, s); }
void hOtaAllow() {
  JsonDocument d; if (!body(d)) return;
  String e;
  if (!otaAllowRelay(String(d["Packet"] | ""), "gateway LAN " + q_->ip.toString(), e)) { err(e, e == "bad_sig" ? 403 : 400); return; }
  send(200, otaStatusJson());
}

/// Giờ của board (quản lý giờ khi offline — rtc.cpp): nguồn giờ, RTC, độ lệch, lần đặt gần nhất.
void hTimeGet() { send(200, rtcStatusJson()); }
/// PC quản trị đặt giờ theo đồng hồ PC: {Ms: UTC ms, Force?}. Đã có giờ server thì cần Force (409 time_from_server).
void hTimePut() {
  JsonDocument d; if (!body(d)) return;
  int64_t ms = d["Ms"] | (int64_t)0;
  String name;
  { JsonDocument a = loadAdmins(); for (JsonObject x : a.as<JsonArray>()) if (String(x["Pk"] | "") == s_sessionPk) { name = x["Name"] | ""; break; } }
  String by = "PC " + (name.length() ? "\"" + name + "\"" : String("quản trị")) + " (" + q_->ip.toString() + ")";
  String e;
  if (!rtcSetFromPc(ms, by, d["Force"] | false, e)) { err(e, e == "time_from_server" ? 409 : 400); return; }
  send(200, rtcStatusJson());
}

/// Trang cài đặt điện thoại (mobile.cpp): GET = đang bật?; PUT {Enabled} — PC quản trị (hoặc GatewayAdmin từ xa) bật lại sau khi KTV đã "Hoàn tất lắp đặt".
void hMobileGet() { send(200, String("{\"Ok\":true,\"Enabled\":") + (mobileEnabled() ? "true" : "false") + "}"); }
void hMobilePut() {
  JsonDocument d; if (!body(d)) return;
  if (!d["Enabled"].is<bool>()) { err("bad_request"); return; }
  mobileSetEnabled(d["Enabled"].as<bool>(), s_rpcAdm.length() ? "từ xa: " + s_rpcAdm : "PC quản trị " + q_->ip.toString());
  hMobileGet();
}

struct Route { const char* method; const char* path; void (*fn)(); bool auth; };
const Route kRoutes[] = {
  {"GET", "/", hRoot, false},
  {"GET", "/api/challenge", hChallenge, false}, {"POST", "/api/login", hLogin, false},
  {"GET", "/api/state", hState, true}, {"GET", "/api/config", hGetConfig, true}, {"GET", "/api/config-message", hConfigMessage, true}, {"PUT", "/api/config", hPutConfig, true},
  {"POST", "/api/write", hWrite, true}, {"POST", "/api/lease", hLease, true}, {"POST", "/api/run", hRun, true}, {"POST", "/api/device", hDevice, true},
  {"POST", "/api/cloud", hCloud, true}, {"GET", "/api/admins", hAdmins, true}, {"POST", "/api/admins", hAdminAction, true}, {"GET", "/api/network", hGetNetwork, true}, {"PUT", "/api/network", hPutNetwork, true}, {"POST", "/api/ota", hOta, true},
  {"GET", "/api/events", hEvents, true}, {"GET", "/api/ota", hOtaState, true}, {"GET", "/api/ota/nonce", hOtaNonce, true}, {"POST", "/api/ota/allow", hOtaAllow, true},
  {"GET", "/api/offline", hOfflineGet, true}, {"PUT", "/api/offline", hOfflinePut, true}, {"POST", "/api/offline/test", hOfflineTest, true},
  {"GET", "/api/wifi/scan", hWifiScan, true}, {"GET", "/api/wifi", hWifiGet, true}, {"PUT", "/api/wifi", hWifiPut, true},
  {"GET", "/api/time", hTimeGet, true}, {"PUT", "/api/time", hTimePut, true},
  {"GET", "/api/mobile", hMobileGet, true}, {"PUT", "/api/mobile", hMobilePut, true},
};

void dispatch(const HttpRequest& q, HttpResponse& r) {
  q_ = &q; r_ = &r;
  if (g_locked && q.path != "/") {   // báo mất trộm: không cho ai đăng nhập / cài đặt (kể cả PC đã ghép)
    JsonDocument d; d["Ok"] = false; d["Err"] = "device_locked"; d["Reason"] = g_lockReason;
    String s; serializeJson(d, s); send(423, s); return;
  }
#ifdef GW_SIM
  // CHỈ bản giả lập (tools/mobile_setup_test.py): gọi apiRpc như gói rpc server đã ký (bỏ qua MQTT + chữ ký) để thử luật phía board
  if (q.path == "/sim/rpc" && getenv("SIM_RPC_TEST")) {
    JsonDocument d; deserializeJson(d, q.body);
    String resp; int st = apiRpc(d["m"] | "GET", d["p"] | "", d["b"] | "", d["adm"] | "", "", resp);
    r.json(st, resp); return;
  }
#endif
  if (mobileHandle(q, r)) return;   // trang cài đặt điện thoại /m + /api/m/* (tự kiểm HTTPS, phiên KTV/PC, đã tắt hay chưa)
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
  IPAddress to = s_udp.remoteIP(); uint16_t port = s_udp.remotePort();
  JsonDocument d;
  d["Kind"] = "mcu"; d["Name"] = g_cfg.mqttId.length() ? g_cfg.site + "/" + g_cfg.device : g_cfg.device;
  d["Hw"] = idHw(); d["Port"] = API_PORT; d["Tls"] = true; d["Version"] = FW_VERSION; if (g_locked) d["Locked"] = true;
  d["Ip"] = netIpFor(to).toString(); d["Mask"] = netMaskFor(to); d["Mac"] = ETH.macAddress();
  { JsonArray pr = d["Protocols"].to<JsonArray>(); for (const char* p : kProtocols) pr.add(p); }
  String s; serializeJson(d, s);
  // trả lời cả unicast lẫn broadcast (như công cụ cấu hình của Waveshare): máy admin KHÁC mạng con vẫn thấy board để đổi IP
  s_udp.beginPacket(to, port); s_udp.print(s); s_udp.endPacket();
  s_udp.beginPacket(IPAddress(255, 255, 255, 255), port); s_udp.print(s); s_udp.endPacket();
}
}  // namespace

void apiOpenWindow(uint32_t ms) {
  if (g_locked) { logf("Thiết bị bị khoá — nút BOOT không mở ghép PC"); return; }
  s_windowUntil = millis() + ms;
  logf("Mở ghép PC admin %lu giây — GatewayApp → \"Kết nối Waveshare\" (HTTPS %s:%d, mã phần cứng %s)",
       (unsigned long)(ms / 1000), netIp().toString().c_str(), API_PORT, idHw().c_str());
}

void apiForgetAdmins() { secretSet("admins", "[]"); }

int apiRpc(const String& method, const String& path, const String& body, const String& adm, const String& appr, String& resp) {
  // Board chỉ mở cho cài đặt từ xa: xem trạng thái/nhật ký + đọc/ghi CHƯƠNG TRÌNH LOGIC. Thử mất mạng (đóng/ngắt DO thật),
  // ghi DO, đổi cấu hình thiết bị/mạng/cloud, OTA, PC quản trị: CHỈ tại chỗ.
  static const char* const kRemote[][2] = {
    {"GET", "/api/state"}, {"GET", "/api/config"}, {"GET", "/api/config-message"},
    {"PUT", "/api/config"},   // cửa sổ cài đặt đầy đủ của GatewayAdmin: hPutConfig giữ nguyên thông số cloud + danh tính khi đi từ xa
    {"GET", "/api/offline"}, {"PUT", "/api/offline"}, {"GET", "/api/events"}, {"GET", "/api/ota"},
    {"GET", "/api/mobile"}, {"PUT", "/api/mobile"},   // bật lại trang cài đặt điện thoại cho kỹ thuật viên (GatewayAdmin hỗ trợ từ xa)
    // cài đặt hiện trường cùng lúc với KTV (mobile.cpp tự chặn sửa khi trang đã tắt; ghi thử / DO / hoàn tất chỉ tại chỗ)
    {"GET", "/api/m/state"}, {"POST", "/api/m/catalog"}, {"PUT", "/api/m/port"}, {"POST", "/api/m/device"}, {"POST", "/api/m/remove"},
    {"POST", "/api/m/dio"}, {"POST", "/api/m/probe"},
  };
  bool allowed = false;
  for (auto& r : kRemote) if (method == r[0] && path == r[1]) { allowed = true; break; }
  if (!allowed) { resp = "{\"Ok\":false,\"Err\":\"remote_route_blocked\"}"; return 403; }
  // Đổi chương trình logic từ xa: chỉ khi CHỦ TRẠM đã duyệt trên webapp (server gắn mã duyệt "appr" vào phần được ký).
  if (method == "PUT" && path == "/api/offline" && !appr.length()) { resp = "{\"Ok\":false,\"Err\":\"owner_approval_required\"}"; return 403; }
  HttpRequest q; q.method = method; q.path = path; q.body = body; q.tls = true;
  HttpResponse r;
  s_rpcAdm = (adm.length() ? adm : String("GatewayAdmin")) + (appr.length() ? ", chủ trạm duyệt " + appr : String(""));
  dispatch(q, r);
  s_rpcAdm = "";
  q_ = nullptr; r_ = nullptr;
  resp = r.body;
  return r.code;
}

bool apiStarted() { return s_started; }
bool apiAdminToken(const String& a) { return tokenOk(a); }
String apiRpcCaller() { return s_rpcAdm; }
bool apiWindowOpen() { return windowOpen(); }
void apiApplyChange(const char* why) { applyChange(why); }

void apiBegin() {
  // Cấp điện chỉ mở cửa sổ ghép khi board CHƯA có PC admin nào (mới mua / vừa reset): người lạ rút điện cắm lại không ghép được.
  // Đã có PC ghép: muốn ghép PC mới phải nhấn BOOT (trong tủ điện) hoặc chủ board xác nhận bằng webapp.
  if (activeAdmins() == 0) apiOpenWindow(SETUP_WINDOW_MS);
  else logf("Đã có PC admin ghép — ghép PC mới: nhấn BOOT trên board hoặc đăng nhập webapp của chủ board");
}

void apiLoop() {
  if (!s_started) {
    if (!netUp()) return;   // chờ có IP (Ethernet hoặc Wi-Fi) mới mở cổng
    s_https.begin(); s_http.begin(); s_udp.begin(DISCOVER_PORT); s_started = true;
    logf("Cài đặt: https://%s:%d (trang trạng thái http://%s/) — tìm thiết bị UDP %d",
         netIp().toString().c_str(), API_PORT, netIp().toString().c_str(), DISCOVER_PORT);
  }
  s_https.handle(dispatch);
  s_http.handle(dispatch);
  udpLoop();
  tickPending();
  if (s_restartAt && (int32_t)(millis() - s_restartAt) >= 0) { logf("Khởi động lại (đổi mạng / đổi chủ)"); enterSafeState("khởi động lại"); delay(100); ESP.restart(); }
}
