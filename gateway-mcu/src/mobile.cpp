// TRANG CÀI ĐẶT BẰNG ĐIỆN THOẠI cho kỹ thuật viên lắp tủ (không mang laptop): https://<IP board>/m — chi tiết docs/MOBILE-SETUP.md.
//
// Ai vào được: nhấn nút BOOT trên board (cửa sổ cài đặt 10 phút — người đứng cạnh tủ) → "phiên kỹ thuật viên" (KTV).
//   Phiên KTV CHỈ chạm được: cổng RS485 (baud/khung/chu kỳ), thiết bị RS485 theo MẪU từ server, DI/DO của board, đọc/ghi thử.
//   KHÔNG thấy/đổi: cloud, chương trình logic, PC quản trị, mạng, firmware, nhật ký. Board đã có chủ: KHÔNG xoá dữ liệu chủ (khác ghép PC),
//   mỗi lần KTV đăng nhập gửi cảnh báo đỏ về điện thoại chủ trạm (evLog alertOwner). PC quản trị đã đăng nhập cũng dùng được trang này.
// Kênh: HTTPS (chứng chỉ tự ký của board — trình duyệt cảnh báo một lần). Cổng 80 chỉ có trang dẫn sang HTTPS.
// Tắt khi chạy thật: KTV bấm "Hoàn tất lắp đặt" (hoặc PC quản trị PUT /api/mobile {Enabled:false}) → NVS m_off: /m và /api/m/* trả "đã tắt",
//   nút BOOT KHÔNG bật lại. Bật lại: PC quản trị (GatewayApp, LAN) hoặc GatewayAdmin từ xa (chủ trạm cho phép hỗ trợ) — PUT /api/mobile.
// Mẫu thiết bị: board tải GET <server>/api/v1/device-templates (?since=rev → 304 khi không đổi) mỗi lần mở danh sách → kỹ sư sửa trên
//   GatewayAdmin là KTV thấy ngay; mất mạng thì dùng bản lưu /tpl.json. Thiết bị thêm vào = chép hẳn field vào cấu hình (không phụ thuộc server).
//
//   POST /api/m/login {Name}        → {Token}   (cần cửa sổ BOOT)       GET  /api/m/state           cổng, thiết bị, DI/DO, giá trị
//   POST /api/m/catalog {}          → mẫu RS485                          PUT  /api/m/port {Baud,Parity,PollMs}
//   POST /api/m/device {Template,Unit,Title,Show[],Child?}               POST /api/m/remove {Child}
//   POST /api/m/dio {Kind:"do"|"di",Ch,Title,Icon,Fb,Child?}             POST /api/m/probe {Child} | {Template,Unit}
//   POST /api/m/write {Child,Field,Value}                                POST /api/m/do {Ch,On}   (thử chân DO trước khi đặt tên)
//   POST /api/m/finish              → tắt trang (chạy thật)              POST /api/m/logout
#include "gw.h"
#include "https.h"
#include "board.h"
#include "mobile_page.h"
#include <LittleFS.h>
#include <esp_random.h>
#include <algorithm>

namespace {
struct Tech { String token, name; uint32_t last; IPAddress ip; };
std::vector<Tech> s_tech;
const uint32_t kIdleMs = 30 * 60 * 1000UL;
int s_fails = 0; uint32_t s_failStart = 0;
const char* kTplPath = "/tpl.json";
const HttpRequest* q_ = nullptr;
HttpResponse* r_ = nullptr;
String s_who;   // người đang thao tác (nhật ký)
// Thay đổi gần nhất (để điện thoại ↔ GatewayAdmin thấy việc của nhau): ai, làm gì, ở rev nào
String s_lastBy, s_lastWhat; int s_lastRev = -1;
String s_dc; uint32_t s_dcUntil = 0, s_dcLastPoll = 0;   // gắn tài khoản: deviceCode (bí mật, chỉ trong RAM board)

void send(int st, const String& s) { r_->json(st, s); }
void sendDoc(JsonDocument& d, int st = 200) { String s; serializeJson(d, s); send(st, s); }
void fail(const String& code, const String& msg, int st = 400) { JsonDocument d; d["Ok"] = false; d["Err"] = code; d["Msg"] = msg; sendDoc(d, st); }
void okMsg(const String& msg = "") { JsonDocument d; d["Ok"] = true; if (msg.length()) d["Msg"] = msg; sendDoc(d); }
bool body(JsonDocument& d) { if (deserializeJson(d, q_->body)) { fail("bad_json", "Dữ liệu gửi lên hỏng."); return false; } return true; }
String hex(const uint8_t* p, size_t n) { String s; char b[3]; for (size_t i = 0; i < n; i++) { sprintf(b, "%02x", p[i]); s += b; } return s; }

bool techOk(const String& a) {
  if (!a.startsWith("Bearer ")) return false;
  String t = a.substring(7); t.trim();
  uint32_t now = millis();
  for (auto it = s_tech.begin(); it != s_tech.end();) {
    if (now - it->last > kIdleMs) { it = s_tech.erase(it); continue; }
    if (it->token.length() == t.length() && it->token == t) { it->last = now; s_who = "KTV \"" + it->name + "\""; return true; }
    ++it;
  }
  return false;
}

String slug(const String& s, int maxLen) {
  String o;
  for (char c : s) { char l = tolower((unsigned char)c); if (isalnum((unsigned char)l)) o += l; else if ((l == '-' || l == '_') && o.length()) o += '-'; if ((int)o.length() >= maxLen) break; }
  while (o.endsWith("-")) o.remove(o.length() - 1);
  return o.length() ? o : String("dev");
}

// ---------------------------------------------------------------- mẫu thiết bị (cache /tpl.json = {rev, templates:[…]} đúng như server trả)
bool loadCatalog(JsonDocument& d) {
  File f = LittleFS.open(kTplPath, "r");
  if (!f) return false;
  bool ok = !deserializeJson(d, f) && d["templates"].is<JsonArray>();
  f.close();
  return ok;
}

/// Tải lại từ server nếu được; trả câu báo trạng thái ("" = mới nhất từ server).
String refreshCatalog(JsonDocument& cache) {
  bool have = loadCatalog(cache);
  if (!netUp()) return have ? "Board chưa có mạng — dùng danh sách đã lưu." : "Board chưa có mạng và chưa từng tải danh sách thiết bị mẫu.";
  String base = g_cfg.apiUrl.length() ? g_cfg.apiUrl : String("https://plc.dieukhientudong.net");
  while (base.endsWith("/")) base.remove(base.length() - 1);
  String url = base + "/api/v1/device-templates";
  if (have) url += "?since=" + String((double)(cache["rev"] | 0.0), 0);
  String resp;
  int st = httpsGet(url, resp);
  if (st == 304 && have) return "";
  if (st == 200) {
    JsonDocument n;
    if (!deserializeJson(n, resp) && n["templates"].is<JsonArray>()) {
      File f = LittleFS.open("/tpl.tmp", "w");
      if (f) { f.print(resp); f.close(); LittleFS.rename("/tpl.tmp", kTplPath); }
      cache.set(n);
      logf("Đã tải %u mẫu thiết bị từ server", (unsigned)n["templates"].size());
      return "";
    }
  }
  String why = st < 0 ? httpsLastError() : "HTTP " + String(st);
  return have ? "Không tải được danh sách mới (" + why + ") — dùng bản đã lưu." : "Không tải được danh sách thiết bị mẫu (" + why + ").";
}

JsonObject findTpl(JsonDocument& cat, const String& id) {
  for (JsonObject t : cat["templates"].as<JsonArray>()) if (id == (t["id"] | "")) return t;
  return JsonObject();
}

// ---------------------------------------------------------------- cấu hình: sửa trên bản sao → storeValidate → áp dụng
JsonObject rtuConn(JsonObject cfg) {
  for (JsonObject k : cfg["Connections"].as<JsonArray>()) if (String(k["Protocol"] | "") == "ModbusRtu") return k;
  return JsonObject();
}
/// Có kết nối Modbus RTU chưa; chưa có → tạo theo baud/parity (mặc định 9600 8-N-1). Trả kết nối.
JsonObject ensureRtu(JsonObject cfg, int baud = 9600, const char* parity = "None") {
  JsonObject k = rtuConn(cfg);
  if (!k.isNull()) return k;
  if (!cfg["Connections"].is<JsonArray>()) cfg["Connections"].to<JsonArray>();
  k = cfg["Connections"].as<JsonArray>().add<JsonObject>();
  k["Protocol"] = "ModbusRtu"; k["Host"] = "RS485"; k["Port"] = baud;
  JsonObject o = k["Options"].to<JsonObject>(); o["parity"] = parity;
  return k;
}
void removeChild(JsonDocument& nd, const String& child) {
  JsonArray pack = nd["Config"]["Pack"].as<JsonArray>();
  for (int i = (int)pack.size() - 1; i >= 0; i--) if (child == (pack[i]["Child"] | "")) pack.remove(i);
  JsonObject fm = nd["Fields"].as<JsonObject>();
  std::vector<String> drop;
  for (JsonPair kv : fm) { String k = kv.key().c_str(); if (k.startsWith(child + ".")) drop.push_back(k); }
  for (auto& k : drop) fm.remove(k);
  nd["Devices"].as<JsonObject>().remove(child);
}
bool childExists(JsonDocument& nd, const String& child) {
  for (JsonObject p : nd["Config"]["Pack"].as<JsonArray>()) if (child == (p["Child"] | "")) return true;
  return false;
}
String childTitle(JsonDocument& nd, const String& child) { String t = nd["Devices"][child]["Title"] | ""; return t.length() ? t : child; }
String newChild(JsonDocument& nd, const String& base) {
  String b = slug(base, 24), c = b;
  for (int i = 2; childExists(nd, c); i++) c = b + "-" + String(i);
  return c;
}
/// Lưu bản sao vào cấu hình đang chạy. false = đã trả lỗi.
bool commit(JsonDocument& nd, const String& why) {
  String e = storeValidate(nd["Config"].as<JsonObjectConst>());
  if (e.length()) { fail("invalid", e); return false; }
  { Lock l; g_raw.set(nd); }
  String w = s_who + ": " + why;
  apiApplyChange(w.c_str());
  s_lastBy = s_who; s_lastWhat = why; s_lastRev = g_rev;
  evLog("mobile_cfg", w);
  return true;
}
/// Sửa đồng thời: yêu cầu kèm Rev đã thấy mà cấu hình đã đổi (người kia vừa lưu) → 409, bên gửi tải lại rồi làm lại. Không gửi Rev = bỏ qua kiểm.
bool revOk(JsonDocument& d) {
  if (d["Rev"].isNull() || (int)(d["Rev"] | -1) == g_rev) return true;
  JsonDocument o; o["Ok"] = false; o["Err"] = "rev_conflict"; o["Rev"] = g_rev;
  o["Msg"] = s_lastRev == g_rev && s_lastBy.length() ? s_lastBy + " vừa sửa (" + s_lastWhat + ") — đã tải lại, kiểm tra rồi làm lại." : String("Cấu hình vừa được sửa ở nơi khác — đã tải lại, kiểm tra rồi làm lại.");
  sendDoc(o, 409);
  return false;
}
void copyRaw(JsonDocument& nd) {
  Lock l; nd.set(g_raw);
  if (!nd["Config"]["Pack"].is<JsonArray>()) nd["Config"]["Pack"].to<JsonArray>();
  if (!nd["Fields"].is<JsonObject>()) nd["Fields"].to<JsonObject>();
  if (!nd["Devices"].is<JsonObject>()) nd["Devices"].to<JsonObject>();
}

// ---------------------------------------------------------------- handlers
void hLogin() {
  uint32_t now = millis();
  if (s_fails >= 5 && now - s_failStart < 60000) { fail("too_many_attempts", "Thử quá nhiều lần — chờ 1 phút.", 429); return; }
  if (!apiWindowOpen()) {
    if (now - s_failStart >= 60000) { s_fails = 0; s_failStart = now; }
    s_fails++;
    fail("press_boot", "Nhấn nút BOOT trên board (bên cạnh cổng USB) rồi bấm Đăng nhập trong vòng 10 phút.", 403); return;
  }
  JsonDocument d; if (!body(d)) return;
  String name = d["Name"] | ""; name.trim(); if (name.length() > 32) name = name.substring(0, 32);
  if (!name.length()) { fail("name_required", "Nhập tên kỹ thuật viên (để chủ trạm biết ai đã cài đặt)."); return; }
  uint8_t r[16]; esp_fill_random(r, sizeof r);
  if (s_tech.size() >= 3) s_tech.erase(s_tech.begin());
  s_tech.push_back({hex(r, sizeof r), name, now, q_->ip});
  logf("Kỹ thuật viên \"%s\" đăng nhập trang cài đặt điện thoại từ %s", name.c_str(), q_->ip.toString().c_str());
  evLog("tech_login", "Kỹ thuật viên \"" + name + "\" đăng nhập cài đặt tại chỗ bằng điện thoại (" + q_->ip.toString() + ")", true);
  ioBeep(60);
  JsonDocument o; o["Ok"] = true; o["Token"] = s_tech.back().token; o["Name"] = name; sendDoc(o);
}

void hLogout() {
  String t = q_->auth.substring(7); t.trim();
  for (auto it = s_tech.begin(); it != s_tech.end(); ++it) if (it->token == t) { s_tech.erase(it); break; }
  okMsg();
}

void hState() {
  JsonDocument d;
  d["Ok"] = true; d["Hw"] = idHw(); d["Version"] = FW_VERSION; d["Who"] = s_who; d["Cloud"] = cloudStateName();
  d["Status"] = g_running ? g_status : String("đã dừng"); d["Gateway"] = leaseActive();   // đang là slave của gateway PC: PC đọc thiết bị, board vẫn đọc thử được
  d["SafeMode"] = safeMode(); d["DoOk"] = ioDoOk();
  { JsonObject a = d["Account"].to<JsonObject>(); a["Registered"] = g_cfg.mqttId.length() > 0; a["Site"] = g_cfg.site; a["Device"] = g_cfg.device; a["Pending"] = s_dc.length() > 0; }
  d["Rev"] = g_rev; d["Enabled"] = mobileEnabled(); d["Remote"] = apiRpcCaller().length() > 0;
  { JsonArray t = d["Techs"].to<JsonArray>(); uint32_t now = millis(); for (auto& x : s_tech) if (now - x.last <= kIdleMs) t.add(x.name); }
  if (s_lastRev >= 0) { JsonObject lc = d["LastChange"].to<JsonObject>(); lc["By"] = s_lastBy; lc["What"] = s_lastWhat; lc["Rev"] = s_lastRev; }
  JsonDocument raw; copyRaw(raw);
  JsonObject cfg = raw["Config"];
  JsonObject port = d["Port"].to<JsonObject>();
  JsonObject k = rtuConn(cfg);
  port["Set"] = !k.isNull(); port["Baud"] = k.isNull() ? 9600 : (int)(k["Port"] | 9600); port["Parity"] = k.isNull() ? String("None") : String(k["Options"]["parity"] | "None");
  port["PollMs"] = cfg["PollMs"] | 1000;
  uint8_t di = ioDi(), dout = ioDo();
  JsonArray adi = d["Di"].to<JsonArray>(), ado = d["Do"].to<JsonArray>();
  for (int i = 0; i < 8; i++) { adi.add((di >> i) & 1); ado.add((dout >> i) & 1); }
  // thiết bị theo thứ tự xuất hiện
  JsonArray devs = d["Devices"].to<JsonArray>();
  std::vector<String> order;
  for (JsonObject p : cfg["Pack"].as<JsonArray>()) { String c = p["Child"] | ""; if (std::find(order.begin(), order.end(), c) == order.end()) order.push_back(c); }
  JsonDocument vals; JsonObject vo = vals.to<JsonObject>(); engineValues(vo);
  for (auto& c : order) {
    JsonObject o = devs.add<JsonObject>();
    JsonObject meta = raw["Devices"][c];
    o["Child"] = c; o["Title"] = childTitle(raw, c); o["Icon"] = String(meta["Template"] | ""); o["Model"] = String(meta["Model"] | "");
    String kind = "other"; int unit = -1, ch = 0;
    JsonArray fs = o["Fields"].to<JsonArray>();
    bool paused = false;
    for (JsonObject p : cfg["Pack"].as<JsonArray>()) {
      if (c != (p["Child"] | "")) continue;
      String proto = p["Protocol"] | ""; int u = String(p["Params"]["unit"] | "1").toInt(); int a = p["Address"] | 0;
      if (proto == "ModbusRtu" && u == 0) { kind = "dio"; if (a >= 20 && a <= 27 && !ch) ch = a - 19; else if (a >= 10 && a <= 17 && !ch) ch = -(a - 9); }
      else if (proto == "ModbusRtu") { kind = "rs485"; unit = u; }
      else if (proto == "ModbusTcp" && kind == "other") kind = "tcp";
      if (!(p["Enabled"] | true)) paused = true;
      String f = p["Field"] | "";
      JsonObject m = raw["Fields"][c + "." + f];
      JsonObject x = fs.add<JsonObject>();
      x["Field"] = f; String t = m["Title"] | ""; x["Label"] = t.length() ? t : f; x["Unit"] = String(m["Unit"] | ""); x["Access"] = String(p["Access"] | "ReadWrite");
      x["Kind"] = String(m["Kind"] | "auto"); x["On"] = String(m["OnText"] | ""); x["Off"] = String(m["OffText"] | "");
      if (!p["Min"].isNull()) x["Min"] = p["Min"]; if (!p["Max"].isNull()) x["Max"] = p["Max"];
      String key = c + "." + f; if (!vo[key].isNull()) x["Value"] = vo[key];
    }
    o["Kind"] = kind; if (unit >= 0) o["Unit"] = unit; if (ch) o["Ch"] = ch; if (paused) o["Paused"] = true;
  }
  sendDoc(d);
}

void hCatalog() {
  JsonDocument cat;
  String msg = refreshCatalog(cat);
  JsonDocument o; o["Ok"] = true; if (msg.length()) o["Msg"] = msg;
  o["Rev"] = cat["rev"] | 0.0;
  if (cat["templates"].is<JsonArray>()) o["Templates"].set(cat["templates"]); else o["Templates"].to<JsonArray>();
  sendDoc(o);
}

void hPort() {
  JsonDocument d; if (!body(d)) return;
  if (!revOk(d)) return;
  int baud = d["Baud"] | 0; String par = d["Parity"] | ""; int poll = d["PollMs"] | 0;
  static const int kBauds[] = {1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200};
  bool bok = false; for (int b : kBauds) if (b == baud) bok = true;
  if (!bok) { fail("bad_baud", "Tốc độ baud không hợp lệ."); return; }
  if (par != "None" && par != "Even" && par != "Odd") { fail("bad_parity", "Khung truyền phải là 8-N-1, 8-E-1 hoặc 8-O-1."); return; }
  if (poll < 500 || poll > 60000) { fail("bad_poll", "Chu kỳ đọc từ 0,5 đến 60 giây."); return; }
  JsonDocument nd; copyRaw(nd);
  JsonObject cfg = nd["Config"];
  JsonObject k = ensureRtu(cfg, baud, par.c_str());
  k["Port"] = baud; if (!k["Options"].is<JsonObject>()) k["Options"].to<JsonObject>(); k["Options"]["parity"] = par;
  cfg["PollMs"] = poll;
  if (commit(nd, "cổng RS485 " + String(baud) + " 8-" + par.substring(0, 1) + "-1, đọc mỗi " + String(poll) + " ms")) okMsg("Đã lưu cổng RS485.");
}

/// Field của một thiết bị RS485 theo mẫu (chỉ các khoá được chọn). Dùng cho cả thêm thiết bị và đọc thử trước khi thêm.
void tplPack(JsonObject tpl, int unit, const String& child, JsonArrayConst show, JsonArray pack, JsonObject fieldsMeta) {
  for (JsonObject f : tpl["fields"].as<JsonArray>()) {
    String key = f["key"] | "";
    bool on = false;
    if (show.isNull()) on = f["show"] | true;
    else for (JsonVariantConst s : show) if (key == (s | "")) on = true;
    if (!on) continue;
    JsonObject p = pack.add<JsonObject>();
    String acc = f["access"] | "r", type = f["type"] | "UInt16", order = f["order"] | "";
    p["Child"] = child; p["Field"] = key; p["MqttKey"] = ""; p["Address"] = f["addr"] | 0; p["Scale"] = f["scale"] | 1.0;
    p["Protocol"] = "ModbusRtu"; p["Access"] = String(acc == "rw" ? "ReadWrite" : acc == "w" ? "Write" : "Read"); p["DataType"] = type;
    p["WordSwap"] = order == "CDAB" || order == "DCBA"; p["Enabled"] = true;
    if (!f["min"].isNull()) p["Min"] = f["min"]; if (!f["max"].isNull()) p["Max"] = f["max"];
    JsonObject pr = p["Params"].to<JsonObject>();
    pr["unit"] = String(unit); pr["fc"] = String((int)(f["fc"] | 3));
    if ((int)(f["wfc"] | 0) == 16) pr["wfc"] = "16";
    if (order == "BA" || order == "BADC" || order == "DCBA") pr["bswap"] = "1";
    if (!fieldsMeta.isNull()) {
      JsonObject m = fieldsMeta[child + "." + key].to<JsonObject>();
      m["Kind"] = String(f["kind"] | "auto"); m["Unit"] = String(f["unit"] | ""); m["Title"] = f["label"].is<const char*>() ? String(f["label"].as<const char*>()) : key;
      if (!f["min"].isNull()) m["Min"] = f["min"]; if (!f["max"].isNull()) m["Max"] = f["max"];
      if (f["on"].is<const char*>()) m["OnText"] = String(f["on"].as<const char*>()); if (f["off"].is<const char*>()) m["OffText"] = String(f["off"].as<const char*>());
    }
  }
}

/// Slave ID đã dùng bởi thiết bị khác trên cổng RS485 → tên thiết bị đó ("" = trống) + gợi ý số trống nhỏ nhất.
String unitOwner(JsonDocument& nd, int unit, const String& except, int& suggest) {
  std::vector<bool> used(248, false); String owner;
  for (JsonObject p : nd["Config"]["Pack"].as<JsonArray>()) {
    if (String(p["Protocol"] | "") != "ModbusRtu") continue;
    String c = p["Child"] | ""; if (c == except) continue;
    int u = String(p["Params"]["unit"] | "1").toInt();
    if (u >= 1 && u <= 247) used[u] = true;
    if (u == unit && !owner.length()) owner = childTitle(nd, c);
  }
  suggest = 0; for (int i = 1; i <= 247; i++) if (!used[i] && i != unit) { suggest = i; break; }
  return owner;
}

void hDevice() {
  JsonDocument d; if (!body(d)) return;
  if (!revOk(d)) return;
  String tid = d["Template"] | "", title = d["Title"] | "", child = d["Child"] | ""; int unit = d["Unit"] | 0;
  title.trim(); if (title.length() > 40) title = title.substring(0, 40);
  if (unit < 1 || unit > 247) { fail("bad_unit", "Địa chỉ trạm (Slave ID) từ 1 đến 247."); return; }
  JsonDocument cat; loadCatalog(cat);
  JsonObject tpl = findTpl(cat, tid);
  if (tpl.isNull()) { fail("no_template", "Không có mẫu thiết bị này trên board — mở lại danh sách để tải mẫu mới."); return; }
  if (!title.length()) title = tpl["name"] | "Thiết bị";
  JsonDocument nd; copyRaw(nd);
  if (child.length() && !childExists(nd, child)) { fail("no_device", "Thiết bị này không còn (có thể vừa bị xoá ở máy khác)."); return; }
  int sug = 0; String owner = unitOwner(nd, unit, child, sug);
  if (owner.length()) {
    JsonDocument o; o["Ok"] = false; o["Err"] = "unit_used"; o["Suggest"] = sug;
    o["Msg"] = "Địa chỉ ID " + String(unit) + " đã dùng cho \"" + owner + "\", vui lòng chọn số khác" + (sug ? " (gợi ý: ID " + String(sug) + ")." : String("."));
    sendDoc(o, 409); return;
  }
  bool editing = child.length() > 0;
  if (editing) removeChild(nd, child); else child = newChild(nd, tid);
  JsonObject cfg = nd["Config"];
  bool hadPort = !rtuConn(cfg).isNull();
  JsonObject k = ensureRtu(cfg, tpl["serial"]["baud"] | 9600, tpl["serial"]["parity"] | "None");
  JsonArrayConst show = d["Show"].as<JsonArrayConst>();
  tplPack(tpl, unit, child, show, cfg["Pack"].as<JsonArray>(), nd["Fields"].as<JsonObject>());
  if (!childExists(nd, child)) { fail("no_fields", "Chọn ít nhất một thông số để hiển thị."); return; }
  JsonObject dm = nd["Devices"][child].to<JsonObject>();
  dm["Title"] = title; dm["Template"] = String(tpl["icon"] | "dev"); dm["Icon"] = ""; dm["Color"] = ""; dm["Model"] = tid;
  if (!commit(nd, String(editing ? "sửa" : "thêm") + " thiết bị RS485 \"" + title + "\" (" + tid + ", ID " + String(unit) + ")")) return;
  JsonDocument o; o["Ok"] = true; o["Child"] = child;
  int tb = tpl["serial"]["baud"] | 9600; String tp = tpl["serial"]["parity"] | "None";
  if (hadPort && ((int)(k["Port"] | 0) != tb || String(k["Options"]["parity"] | "") != tp))
    o["Msg"] = "Lưu ý: mẫu này mặc định " + String(tb) + " 8-" + tp.substring(0, 1) + "-1, khác cài đặt cổng RS485 hiện tại. Mọi thiết bị trên cùng dây phải cùng tốc độ.";
  sendDoc(o);
}

void hRemove() {
  JsonDocument d; if (!body(d)) return;
  if (!revOk(d)) return;
  String child = d["Child"] | "";
  JsonDocument nd; copyRaw(nd);
  if (!childExists(nd, child)) { fail("no_device", "Không có thiết bị này."); return; }
  String t = childTitle(nd, child);
  removeChild(nd, child);
  if (commit(nd, "xoá thiết bị \"" + t + "\"")) okMsg("Đã xoá " + t + ".");
}

/// DI/DO của board: DO (tuỳ chọn DI phản hồi) hoặc DI. Child "do<n>"/"di<n>" — kênh đã gán cho thiết bị khác → báo trùng.
void hDio() {
  JsonDocument d; if (!body(d)) return;
  if (!revOk(d)) return;
  String kind = d["Kind"] | "", title = d["Title"] | "", icon = d["Icon"] | "", child = d["Child"] | "";
  int ch = d["Ch"] | 0, fb = d["Fb"] | 0;
  title.trim(); if (title.length() > 40) title = title.substring(0, 40);
  if ((kind != "do" && kind != "di") || ch < 1 || ch > 8 || fb < 0 || fb > 8 || (kind == "di" && fb)) { fail("bad_request", "Chọn kênh 1–8."); return; }
  if (!title.length()) title = (kind == "do" ? "DO" : "DI") + String(ch);
  JsonDocument nd; copyRaw(nd);
  if (child.length() && !childExists(nd, child)) { fail("no_device", "Thiết bị này không còn."); return; }
  int wantDo = kind == "do" ? 20 + ch - 1 : -1, wantDi = kind == "di" ? 10 + ch - 1 : fb ? 10 + fb - 1 : -1;
  for (JsonObject p : nd["Config"]["Pack"].as<JsonArray>()) {
    String c = p["Child"] | ""; if (c == child) continue;
    if (String(p["Protocol"] | "") != "ModbusRtu" || String(p["Params"]["unit"] | "1") != "0") continue;
    int a = p["Address"] | -1;
    if (a == wantDo || (a == 1 && wantDo >= 0 && String(p["Access"] | "") != "Read")) { fail("ch_used", "DO" + String(ch) + " đã dùng cho \"" + childTitle(nd, c) + "\".", 409); return; }
    if (a == wantDi && kind == "di") { fail("ch_used", "DI" + String(ch) + " đã dùng cho \"" + childTitle(nd, c) + "\".", 409); return; }
  }
  if (child.length()) removeChild(nd, child); else child = newChild(nd, kind + String(ch));
  JsonObject cfg = nd["Config"];
  ensureRtu(cfg);
  JsonArray pack = cfg["Pack"].as<JsonArray>();
  auto add = [&](const String& field, int addr, const String& acc, const String& mkind, const String& label, const String& on, const String& off) {
    JsonObject p = pack.add<JsonObject>();
    p["Child"] = child; p["Field"] = field; p["MqttKey"] = ""; p["Address"] = addr; p["Scale"] = 1; p["Protocol"] = "ModbusRtu";
    p["Access"] = acc; p["DataType"] = "UInt16"; p["WordSwap"] = false; p["Enabled"] = true; p["Min"] = 0; p["Max"] = 1;
    p["Params"].to<JsonObject>()["unit"] = "0";
    JsonObject m = nd["Fields"][child + "." + field].to<JsonObject>();
    m["Kind"] = mkind; m["Unit"] = ""; m["Title"] = label; m["Min"] = 0; m["Max"] = 1;
    if (on.length()) m["OnText"] = on; if (off.length()) m["OffText"] = off;
    return m;
  };
  if (kind == "do") {
    JsonObject m = add("on", wantDo, "ReadWrite", "toggle", title, String(d["On"] | "Bật"), String(d["Off"] | "Tắt"));
    if (fb) { add("fb", wantDi, "Read", "number", "Phản hồi DI" + String(fb), "", ""); m["Feedback"] = "fb"; }
  } else add("in", wantDi, "Read", "number", title, "", "");
  JsonObject dm = nd["Devices"][child].to<JsonObject>();
  dm["Title"] = title; dm["Template"] = icon.length() ? icon : String(kind == "do" ? "do" : "di"); dm["Icon"] = ""; dm["Color"] = "";
  if (!commit(nd, String(kind == "do" ? "DO" : "DI") + String(ch) + " = \"" + title + "\"" + (fb ? " (phản hồi DI" + String(fb) + ")" : String("")))) return;
  JsonDocument o; o["Ok"] = true; o["Child"] = child; sendDoc(o);
}

String errVi(const String& e) {
  if (e == "timeout") return "Không trả lời — kiểm tra dây A+/B-, Slave ID, tốc độ baud";
  if (e == "bad_crc" || e == "short_frame") return "Nhiễu / sai khung — kiểm tra baud, parity, điện trở cuối đường dây";
  if (e == "wrong_unit") return "Thiết bị khác trả lời — trùng Slave ID?";
  if (e == "illegal_address") return "Thiết bị báo sai địa chỉ thanh ghi (mẫu không hợp model này?)";
  if (e == "illegal_function") return "Thiết bị không hỗ trợ lệnh đọc này";
  if (e == "no_rtu_connection") return "Chưa lưu cài đặt cổng RS485";
  if (e == "read_only") return "Thông số chỉ đọc";
  if (e == "value_out_of_range") return "Giá trị ngoài khoảng cho phép";
  if (e == "toggle_too_fast") return "Đổi trạng thái quá nhanh (bảo vệ tiếp điểm) — chờ rồi thử lại";
  if (e == "safe_mode") return "Board đang ở chế độ an toàn — không cho BẬT đầu ra";
  if (e == "do_unavailable") return "Không điều khiển được DO (chip TCA9554 không trả lời)";
  if (e.startsWith("logic_")) return "Chương trình logic chặn lệnh này";
  if (e == "plc_error") return "Thiết bị không nhận lệnh ghi";
  if (e == "device_paused") return "Thiết bị đang tạm dừng";
  return e;
}

/// Đọc thử: {Child} = mọi field đọc được của thiết bị đã lưu; {Template, Unit} = thông số "đọc thử" của mẫu (chưa lưu).
void hProbe() {
  JsonDocument d; if (!body(d)) return;
  std::vector<Field> fs; std::vector<String> labels, units;
  String child = d["Child"] | "";
  if (child.length()) {
    Lock l;
    for (auto& f : g_cfg.pack) if (f.child == child && f.access != Access::Write) {
      fs.push_back(f); FieldLook fl = fieldLook(f); labels.push_back(fl.label); units.push_back(fl.unit);
    }
    if (fs.empty()) { fail("no_device", "Không có thiết bị này."); return; }
  } else {
    JsonDocument cat; loadCatalog(cat);
    JsonObject tpl = findTpl(cat, d["Template"] | "");
    int unit = d["Unit"] | 0;
    if (tpl.isNull() || unit < 1 || unit > 247) { fail("bad_request", "Chọn loại thiết bị và Slave ID."); return; }
    JsonDocument tmp; JsonArray pack = tmp["p"].to<JsonArray>();
    tplPack(tpl, unit, "probe", tpl["test"].as<JsonArrayConst>(), pack, JsonObject());
    for (JsonObject p : pack) {
      Field f; f.child = "probe"; f.field = p["Field"] | ""; f.addr = p["Address"] | 0; f.scale = p["Scale"] | 1.0; f.proto = Proto::ModbusRtu; f.protocol = "ModbusRtu";
      String t = p["DataType"] | "UInt16";
      f.type = t == "Int16" ? DType::Int16 : t == "UInt32" ? DType::UInt32 : t == "Int32" ? DType::Int32 : t == "Float32" ? DType::Float32 : t == "Float64" ? DType::Float64 : t == "Bool" ? DType::Bool : DType::UInt16;
      f.swap = p["WordSwap"] | false; f.unit = unit; f.fc = String(p["Params"]["fc"] | "3") == "4" ? 4 : 3; f.bswap = String(p["Params"]["bswap"] | "") == "1";
      fs.push_back(f);
      for (JsonObject tf : tpl["fields"].as<JsonArray>()) if (f.field == (tf["key"] | "")) { labels.push_back(tf["label"] | f.field); units.push_back(tf["unit"] | ""); break; }
    }
  }
  std::vector<double> vals; std::vector<String> errs;
  engineProbe(fs, vals, errs);
  JsonDocument o; JsonArray items = o["Items"].to<JsonArray>(); int good = 0;
  for (size_t i = 0; i < fs.size(); i++) {
    JsonObject x = items.add<JsonObject>();
    x["Field"] = fs[i].field; x["Label"] = i < labels.size() ? labels[i] : fs[i].field; x["Unit"] = i < units.size() ? units[i] : String("");
    if (errs[i].length()) { x["Err"] = errVi(errs[i]); } else { x["Value"] = vals[i]; good++; }
  }
  o["Ok"] = good > 0;
  if (!good) o["Msg"] = items.size() ? String(items[0]["Err"] | "Không đọc được") : String("Không có thông số đọc được");
  sendDoc(o);
}

void hWrite() {
  JsonDocument d; if (!body(d)) return;
  String child = d["Child"] | "", field = d["Field"] | "";
  if (!child.length() || !field.length() || !d["Value"].is<double>()) { fail("bad_request", "Thiếu thông số."); return; }
  String e = engineWrite(child, field, d["Value"].as<double>(), false);
  if (e.length()) { fail(e, errVi(e)); return; }
  logf("%s ghi thử %s.%s = %g", s_who.c_str(), child.c_str(), field.c_str(), d["Value"].as<double>());
  okMsg("Đã ghi.");
}

/// Thử chân DO (kiểm tra đấu dây trước khi đặt tên): qua đúng đường ghi DO của board (an toàn, thời gian tối thiểu, logic).
void hDo() {
  JsonDocument d; if (!body(d)) return;
  int ch = d["Ch"] | 0; bool on = d["On"] | false;
  if (ch < 1 || ch > 8) { fail("bad_request", "Kênh 1–8."); return; }
  Field f; f.proto = Proto::ModbusRtu; f.protocol = "ModbusRtu"; f.unit = 0; f.addr = 20 + ch - 1;
  uint16_t w = on ? 1 : 0; String e;
  if (!mbWrite(f, f.addr, &w, 1, e)) { fail(e, errVi(e)); return; }
  logf("%s thử DO%d = %s", s_who.c_str(), ch, on ? "BẬT" : "TẮT");
  okMsg();
}

// ---------------------------------------------------------------- gắn board vào tài khoản chủ trạm (giản lược "Đăng ký" của GatewayApp)
// Kiểu "device code" (gatewayLogin.js): board xin mã 8 số → KTV đưa mã/link cho chủ trạm → chủ trạm mở webapp (Face ID/TOTP như thường) bấm Duyệt
// → board hỏi poll, nhận token đăng ký ngắn hạn → tự ký register bằng khoá của board (cloudAction "register", như khi GatewayApp đăng ký board).
// Điện thoại KHÔNG cầm mật khẩu/token; deviceCode chỉ nằm trong RAM board. Tài khoản khác đang giữ board → server tạo yêu cầu chuyển chủ.

void hAccountStart() {
  if (!netUp()) { fail("offline", "Board chưa có mạng (cắm dây mạng hoặc cài Wi-Fi bằng GatewayApp)."); return; }
  String resp; int st = httpsPost("/api/v1/gateway/login/start", "{}", resp);
  JsonDocument r;
  if (st != 200 || deserializeJson(r, resp) || !r["deviceCode"].is<const char*>()) {
    fail("server", st < 0 ? "Board không nối được server (" + httpsLastError() + ")." : "Server báo lỗi HTTP " + String(st) + "."); return;
  }
  s_dc = r["deviceCode"].as<const char*>(); s_dcUntil = millis() + (uint32_t)(r["expiresIn"] | 600) * 1000UL; s_dcLastPoll = 0;
  logf("%s xin mã gắn tài khoản", s_who.c_str());
  JsonDocument o; o["Ok"] = true; o["UserCode"] = String(r["userCode"] | ""); o["VerifyUrl"] = String(r["verifyUrl"] | ""); o["ExpiresIn"] = r["expiresIn"] | 600;
  sendDoc(o);
}

void hAccountPoll() {
  JsonDocument o; o["Ok"] = true;
  if (!s_dc.length() || (int32_t)(millis() - s_dcUntil) > 0) { s_dc = ""; fail("expired", "Mã đã hết hạn — bấm lấy mã mới."); return; }
  if (s_dcLastPoll && millis() - s_dcLastPoll < 2500) { o["Status"] = "pending"; sendDoc(o); return; }   // server chặn hỏi < 2 giây
  s_dcLastPoll = millis();
  String resp; int st = httpsPost("/api/v1/gateway/login/poll", "{\"deviceCode\":\"" + s_dc + "\"}", resp);
  JsonDocument r; deserializeJson(r, resp);
  String status = r["status"] | "", e = r["error"] | "";
  if (st == 200 && status == "pending") { o["Status"] = "pending"; sendDoc(o); return; }
  if (st == 429) { o["Status"] = "pending"; sendDoc(o); return; }
  if (st != 200 || status != "approved") {
    s_dc = "";
    fail(e.length() ? e : String("server"), e == "denied" ? "Chủ trạm đã từ chối." : e == "expired" ? "Mã đã hết hạn — lấy mã mới." :
         st < 0 ? "Board mất kết nối server." : "Server báo lỗi: " + (e.length() ? e : String(st)));
    return;
  }
  s_dc = "";
  JsonDocument login; login["Token"] = String(r["token"] | ""); login["Uid"] = r["uid"] | 0LL; login["User"] = String(r["user"] | "");
  String lj, msg; serializeJson(login, lj);
  bool ok = cloudAction("register", "", lj, msg);
  evLog("tech_register", s_who + " gắn board vào tài khoản \"" + String(r["user"] | "") + "\": " + msg, false);
  if (!ok) { fail("register", msg); return; }
  g_rev++;
  o["Status"] = "done"; o["User"] = String(r["user"] | ""); o["Msg"] = msg; sendDoc(o);
}

void hFinish() {
  mobileSetEnabled(false, s_who);
  s_tech.clear();
  okMsg("Đã tắt trang cài đặt điện thoại. Muốn mở lại: PC quản trị (GatewayApp) hoặc nhờ hỗ trợ từ xa.");
}

String offPage() {
  return "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Cài đặt</title>"
         "<body style='font-family:sans-serif;padding:24px;max-width:480px;margin:auto'><h2>Trang cài đặt điện thoại đã tắt</h2>"
         "<p>Board đang chạy thật nên trang cài đặt bằng điện thoại được tắt để bảo vệ hệ thống.</p>"
         "<p>Muốn mở lại: dùng <b>GatewayApp</b> trên PC quản trị (cửa sổ Waveshare → Cài đặt điện thoại) hoặc liên hệ bộ phận hỗ trợ.</p>";
}

// remote = GatewayAdmin gọi được qua relay (cài đặt từ xa, chủ trạm cho phép hỗ trợ): XEM + SỬA cấu hình + ĐỌC thử — chỉ khi trang cài đặt
// hiện trường đang BẬT (đang lắp đặt, có KTV tại chỗ kiểm tra). Ghi thử / bật-tắt DO / hoàn tất: CHỈ tại chỗ (đóng cắt thiết bị thật).
struct MRoute { const char* method; const char* path; void (*fn)(); bool remote; };
const MRoute kRoutes[] = {
  {"GET", "/api/m/state", hState, true}, {"POST", "/api/m/catalog", hCatalog, true}, {"PUT", "/api/m/port", hPort, true},
  {"POST", "/api/m/device", hDevice, true}, {"POST", "/api/m/remove", hRemove, true}, {"POST", "/api/m/dio", hDio, true},
  {"POST", "/api/m/probe", hProbe, true}, {"POST", "/api/m/write", hWrite, false}, {"POST", "/api/m/do", hDo, false},
  {"POST", "/api/m/finish", hFinish, false}, {"POST", "/api/m/logout", hLogout, false},
  {"POST", "/api/m/account/start", hAccountStart, false}, {"POST", "/api/m/account/poll", hAccountPoll, false},
};
}  // namespace

bool mobileEnabled() { return secretGet("m_off").length() == 0; }

void mobileSetEnabled(bool on, const String& by) {
  if (on == mobileEnabled()) return;
  secretSet("m_off", on ? "" : (by.length() ? by : String("?")));
  if (!on) s_tech.clear();
  logf(on ? "Bật trang cài đặt điện thoại (%s)" : "Tắt trang cài đặt điện thoại — chạy thật (%s)", by.c_str());
  evLog(on ? "mobile_on" : "mobile_off", String(on ? "Bật" : "Tắt") + " trang cài đặt điện thoại (" + by + ")", on);
}

bool mobileHandle(const HttpRequest& q, HttpResponse& r) {
  bool page = q.path == "/m" || q.path == "/m/";
  if (!page && !q.path.startsWith("/api/m/")) return false;
  q_ = &q; r_ = &r; s_who = "";
  if (!q.tls) {   // cổng 80: chỉ dẫn sang HTTPS (không gửi token/lệnh qua kênh rõ)
    if (page) {
      String u = "https://" + netIp().toString() + (API_PORT == 443 ? String("") : ":" + String(API_PORT)) + "/m";
      r.html("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Cài đặt</title>"
             "<body style='font-family:sans-serif;padding:24px;max-width:480px;margin:auto'><h2>Cài đặt bằng điện thoại</h2>"
             "<p><a href='" + u + "' style='display:inline-block;padding:14px 20px;background:#0a7;color:#fff;border-radius:10px;text-decoration:none;font-size:18px'>Mở trang cài đặt (HTTPS)</a></p>"
             "<p style='color:#555'>Trình duyệt sẽ báo \"kết nối không riêng tư\" vì chứng chỉ do board tự ký → bấm <b>Nâng cao → Tiếp tục</b>.</p>");
    } else send(403, "{\"Ok\":false,\"Err\":\"use_https\"}");
    return true;
  }
  String rpc = apiRpcCaller();
  if (rpc.length()) {   // GatewayAdmin qua relay (cloud.cpp đã kiểm chữ ký server, apiRpc đã lọc route)
    for (auto& rt : kRoutes) {
      if (q.path != rt.path || q.method != rt.method) continue;
      if (!rt.remote) { fail("remote_route_blocked", "Chỉ làm được tại chỗ.", 403); return true; }
      // xem trạng thái luôn được; sửa / đọc thử chỉ khi đang lắp đặt (trang cài đặt hiện trường bật)
      if (!mobileEnabled() && !(q.method == "GET")) { fail("mobile_off", "Board đang chạy thật (cài đặt hiện trường đã tắt) — bật lại trước khi sửa.", 403); return true; }
      s_who = "GatewayAdmin (" + rpc + ")";
      rt.fn(); return true;
    }
    fail("not_found", "not_found", 404); return true;
  }
  if (!mobileEnabled()) {
    if (page) { r.html(offPage()); r.code = 404; } else fail("mobile_off", "Trang cài đặt điện thoại đã tắt (board đang chạy thật).", 403);
    return true;
  }
  if (page) { r.html(String(kMobilePage)); return true; }
  if (q.path == "/api/m/login" && q.method == "POST") { hLogin(); return true; }
  for (auto& rt : kRoutes) {
    if (q.path != rt.path || q.method != rt.method) continue;
    if (techOk(q.auth)) { rt.fn(); return true; }
    if (apiAdminToken(q.auth)) { s_who = "PC quản trị"; rt.fn(); return true; }
    fail("unauthorized", "Phiên đã hết — đăng nhập lại (nhấn BOOT nếu cần).", 401);
    return true;
  }
  fail("not_found", "not_found", 404);
  return true;
}
