// Cấu hình của board: /config.json (LittleFS) = ApiConfig {Config, Fields, Devices} đúng như GatewayApp gửi.
// Board chỉ đọc phần mình dùng (g_cfg) nhưng giữ và trả lại nguyên vẹn mọi trường khác → admin sửa rồi gửi lại không mất gì.
// Mật khẩu MQTT KHÔNG nằm trong file: lưu NVS, không bao giờ trả về qua API (giống ConfigModel() của gateway PC).
#include "gw.h"
#include <LittleFS.h>
#include <Preferences.h>
#include <ETH.h>
#include <esp_heap_caps.h>

namespace {
struct PsramAlloc : ArduinoJson::Allocator {
  void* allocate(size_t n) override { void* p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); return p ? p : malloc(n); }
  void deallocate(void* p) override { heap_caps_free(p); }
  void* reallocate(void* p, size_t n) override { return heap_caps_realloc(p, n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }
} s_alloc;
Preferences s_nvs;
const char* kPath = "/config.json";
}

JsonDocument g_raw(&s_alloc);
Cfg g_cfg;
int g_rev = 0;
SemaphoreHandle_t g_lock = xSemaphoreCreateRecursiveMutex();
SemaphoreHandle_t g_bus = xSemaphoreCreateRecursiveMutex();

bool g_locked = false;
String g_lockReason;

void setLocked(bool on, const String& reason) {
  if (on == g_locked && (!on || reason == g_lockReason)) return;
  g_locked = on; g_lockReason = on ? (reason.length() ? reason : String("server")) : String("");
  s_nvs.putString("lock", g_lockReason);   // storeReset (giữ BOOT 10 giây) không đụng khoá này
  engineRestart();   // bỏ giá trị cũ; vòng đọc dừng/chạy theo g_locked
  logf(on ? "⚠ THIẾT BỊ BỊ KHOÁ (%s) — dừng đọc/điều khiển, từ chối mọi đăng nhập và ghép PC" : "Thiết bị đã được mở khoá%s", g_lockReason.c_str());
}

String secretGet(const char* key) { return s_nvs.getString(key, ""); }
void secretSet(const char* key, const String& v) { s_nvs.putString(key, v); }
String cloudPassword() { return secretGet("cloud_pw"); }
void setCloudPassword(const String& v) { secretSet("cloud_pw", v); }

static String macTail() {
  String m = ETH.macAddress(); m.replace(":", ""); m.toLowerCase();
  return m.length() >= 6 ? m.substring(m.length() - 6) : String((uint32_t)ESP.getEfuseMac(), HEX);
}

static void defaults() {
  g_raw.clear();
  JsonObject c = g_raw["Config"].to<JsonObject>();
  c["ConfigSchema"] = 1;
  c["Site"] = "factory1";
  c["Device"] = "wsh-" + macTail();
  c["Mobile"] = "Off";
  c["PollMs"] = 1000;
  c["CloudTelemetryMinMs"] = 2000;
  c["Pack"].to<JsonArray>();
  c["Connections"].to<JsonArray>();
  g_raw["Fields"].to<JsonObject>();
  g_raw["Devices"].to<JsonObject>();
}

void storeBegin() {
  s_nvs.begin("gw", false);
  g_lockReason = s_nvs.getString("lock", ""); g_locked = g_lockReason.length() > 0;
  if (g_locked) logf("⚠ Thiết bị đang bị KHOÁ (%s) — chờ server mở khoá", g_lockReason.c_str());
  if (!LittleFS.begin(true)) logf("LittleFS lỗi — chạy với cấu hình mặc định (không lưu được)");
  File f = LittleFS.open(kPath, "r");
  bool ok = false;
  if (f) { ok = !deserializeJson(g_raw, f) && g_raw["Config"].is<JsonObject>(); f.close(); }
  if (!ok) { if (f) logf("config.json hỏng — dùng mặc định"); defaults(); }
  storeApply();
}

bool storeSave() {
  g_raw["Config"]["CloudPassword"] = "";
  g_raw["Config"].remove("GatewayKey");
  File f = LittleFS.open("/config.tmp", "w");
  if (!f) return false;
  size_t n = serializeJson(g_raw, f); f.close();
  if (n == 0) return false;
  LittleFS.remove(kPath);
  return LittleFS.rename("/config.tmp", kPath);
}

void storeReset() {
  LittleFS.remove(kPath);
  s_nvs.remove("cloud_pw");
  netReset();   // quên IP đã đặt vẫn tìm lại được board: về 192.168.1.200
  apiForgetAdmins();   // mọi PC admin phải ghép lại (nhấn BOOT)
  defaults();
  storeSave();
  storeApply();
}

// ---------------------------------------------------------------- JSON → g_cfg
static Proto protoOf(const String& s) { return s == "ModbusTcp" ? Proto::ModbusTcp : s == "ModbusRtu" ? Proto::ModbusRtu : s.length() ? Proto::Other : Proto::None; }
static Access accessOf(const char* s) { String v = s ? s : ""; return v == "Read" ? Access::Read : v == "Write" ? Access::Write : Access::ReadWrite; }
static DType typeOf(const char* s) {
  String v = s ? s : "UInt16";
  if (v == "Int16") return DType::Int16; if (v == "Bool") return DType::Bool; if (v == "UInt32") return DType::UInt32;
  if (v == "Int32") return DType::Int32; if (v == "Float32") return DType::Float32; if (v == "Float64") return DType::Float64;
  return DType::UInt16;
}

void storeApply() {
  BusLock b;   // không đổi cấu hình (host/baud) giữa một lần trao đổi với PLC
  Lock l;
  JsonObjectConst c = g_raw["Config"];
  Cfg n;
  n.site = c["Site"] | "factory1"; n.device = c["Device"] | "plc01";
  n.mqttId = c["MqttId"] | ""; n.solution = c["Solution"] | "";
  n.pollMs = max(100, (int)(c["PollMs"] | 1000));
  n.mobile = c["Mobile"] | "Off";
  n.cloudHost = c["CloudHost"] | ""; n.cloudPort = c["CloudPort"] | 48263; n.cloudTransport = c["CloudTransport"] | "mqtts";
  n.cloudUser = c["CloudUser"] | "gw"; n.cloudPin = c["CloudPinSha256"] | ""; n.cmdKey = c["CloudCmdKey"] | "";
  n.apiUrl = c["CloudApiUrl"] | ""; n.qr = c["GatewayQr"] | "";
  n.sendData = c["CloudSendData"] | true;
  n.teleMinMs = max(200, (int)(c["CloudTelemetryMinMs"] | 1000)); n.idleMs = c["CloudIdleTelemetryMs"] | 0;
  n.cmdMaxAgeSec = c["CmdMaxAgeSec"] | 10; n.remoteCmdPerSec = c["RemoteCmdPerSec"] | 5;
  n.retentionDays = c["CloudRetentionDays"] | 1; n.histIntervalSec = max(1, (int)(c["LocalHistoryIntervalSec"] | 10));
  for (JsonObjectConst k : c["Connections"].as<JsonArrayConst>()) {
    Conn x; x.has = true; x.host = k["Host"] | ""; x.port = k["Port"] | 0; x.parity = k["Options"]["parity"] | "Even";
    Proto p = protoOf(k["Protocol"] | "");
    if (p == Proto::ModbusRtu) n.rtu = x; else if (p == Proto::ModbusTcp) n.tcp = x;
  }
  for (JsonObjectConst p : c["Pack"].as<JsonArrayConst>()) {
    Field f;
    f.child = p["Child"] | ""; f.field = p["Field"] | ""; String mk = p["MqttKey"] | ""; mk.trim();
    f.wire = mk.length() ? mk : f.field;
    f.addr = p["Address"] | 0; f.scale = p["Scale"] | 1.0;
    if (!p["Min"].isNull()) { f.hasMin = true; f.min = p["Min"]; }
    if (!p["Max"].isNull()) { f.hasMax = true; f.max = p["Max"]; }
    f.protocol = p["Protocol"] | ""; f.proto = protoOf(f.protocol);
    f.access = accessOf(p["Access"]); f.type = typeOf(p["DataType"]);
    f.swap = p["WordSwap"] | false; f.enabled = p["Enabled"] | true;
    f.unit = String(p["Params"]["unit"] | "1").toInt();
    n.pack.push_back(f);
  }
  g_cfg = n;
}

// ---------------------------------------------------------------- kiểm tra cấu hình admin gửi (tập con của ScadaConfig.Validate + giới hạn của board)
static bool safeName(const String& s, int maxLen) {
  if (s.length() < 1 || (int)s.length() > maxLen) return false;
  for (char ch : s) if (!isalnum((unsigned char)ch) && ch != '_' && ch != '-') return false;
  return true;
}
static bool wireOk(const String& s) {
  if (s.length() < 1 || s.length() > 32) return false;
  for (char ch : s) if (!isalnum((unsigned char)ch) && ch != '_') return false;
  return true;
}

String storeValidate(JsonObjectConst c) {
  if (!safeName(c["Site"] | "", 48) || !safeName(c["Device"] | "", 48)) return "Site/Device chỉ gồm chữ, số, '_' và '-'.";
  if ((int)(c["PollMs"] | 1000) < 100) return "Chu kỳ đọc tối thiểu 100 ms.";
  bool useRtu = false, useTcp = false;
  std::map<String, String> seenWire;
  for (JsonObjectConst p : c["Pack"].as<JsonArrayConst>()) {
    String child = p["Child"] | "", field = p["Field"] | "", proto = p["Protocol"] | "";
    String what = child + "." + field;
    int addr = p["Address"] | -1; double scale = p["Scale"] | 0.0;
    if (child.length() == 0 || field.length() == 0) return "Pack: child/field không được trống.";
    if (addr < 0 || scale <= 0) return "Pack: " + what + " chưa khai báo thanh ghi D / hệ số (mở trang Thiết bị để khai báo).";
    if (proto != "ModbusRtu" && proto != "ModbusTcp")
      return what + ": gateway Waveshare chỉ chạy Modbus RTU (RS485) và Modbus TCP" + (proto.length() ? " — không chạy " + proto + "." : " — field chưa gán giao thức.");
    Field tmp; tmp.type = typeOf(p["DataType"]);
    if (addr + tmp.words() > 300) return what + ": vượt quá D299.";
    String unit = p["Params"]["unit"] | "";
    if (unit.length() == 0 || unit.toInt() < 0 || (unit.toInt() == 0 && unit != "0")) return what + ": thiếu Unit ID.";
    if (proto == "ModbusRtu") useRtu = true; else useTcp = true;
    String mk = p["MqttKey"] | ""; mk.trim(); String wire = mk.length() ? mk : field;
    if (!wireOk(wire)) return "Pack: khoá MQTT \"" + wire + "\" của " + what + " chỉ gồm chữ, số, '_' (tối đa 32 ký tự).";
    String wk = child + "\x01" + wire;
    if (seenWire.count(wk)) return "Pack: khoá MQTT \"" + wire + "\" bị trùng trong thiết bị " + child + ".";
    seenWire[wk] = what;
    if (!p["Min"].isNull() && !p["Max"].isNull() && (double)p["Min"] > (double)p["Max"]) return "Pack: Min không được lớn hơn Max.";
  }
  bool hasRtu = false, hasTcp = false;
  for (JsonObjectConst k : c["Connections"].as<JsonArrayConst>()) {
    String pr = k["Protocol"] | "";
    if (pr == "ModbusRtu") {
      hasRtu = true; int baud = k["Port"] | 0; String par = k["Options"]["parity"] | "";
      if (baud < 1200 || baud > 115200) return "Kết nối Modbus RTU: tốc độ baud (ô Cổng) phải từ 1200 đến 115200.";
      if (par != "Even" && par != "None" && par != "Odd") return "Kết nối Modbus RTU: Parity phải là Even, None hoặc Odd.";
    } else if (pr == "ModbusTcp") {
      hasTcp = true; String h = k["Host"] | ""; int port = k["Port"] | 0;
      if (h.length() == 0) return "Kết nối Modbus TCP: thiếu địa chỉ.";
      if (port < 1 || port > 65535) return "Kết nối Modbus TCP: cổng không hợp lệ.";
    }
  }
  if (useRtu && !hasRtu) return "Thiếu kết nối cho giao thức Modbus RTU (RS485).";
  if (useTcp && !hasTcp) return "Thiếu kết nối cho giao thức Modbus TCP.";
  String mob = c["Mobile"] | "Off";
  if (mob != "Off" && String(c["CloudTransport"] | "mqtts") != "mqtts") return "Gateway Waveshare chỉ nối cloud bằng MQTTS (không WSS).";
  return "";
}

// ---------------------------------------------------------------- bản tin config (ConfigBuilder.cs + MetaDescriber/FieldMeta.ResolveFull của GatewayApp)
struct Resolved { String kind, unit, title; double min, max; };

static Resolved resolve(const Field& p, JsonObjectConst m) {
  String f = p.field; f.toLowerCase();
  Resolved r{"number", "", p.field, 0, 100};
  auto is = [&](std::initializer_list<const char*> xs) { for (auto x : xs) if (f == x) return true; return false; };
  if (is({"level", "lvl", "tank"})) r = {"tank", "%", "", 0, 100};
  else if (is({"run", "on", "v", "enable", "start", "pump"})) r = {"toggle", "", "", 0, 1};
  else if (is({"speed", "sp", "setpoint", "freq", "rpm_sp"})) r = {"slider", "%", "", 0, 100};
  else if (is({"flow"})) r = {"gauge", "L/phút", "", 0, 100};
  else if (is({"t", "temp", "temperature"})) r = {"gauge", "°C", "", 0, 100};
  else if (is({"h", "hum", "humidity"})) r = {"gauge", "%", "", 0, 100};
  else if (is({"p", "pressure", "bar"})) r = {"gauge", "bar", "", 0, 10};
  else if (is({"kw", "power"})) r = {"gauge", "kW", "", 0, 100};
  else if (is({"rpm"})) r = {"gauge", "rpm", "", 0, 3000};
  else if (is({"hours"})) r = {"number", "h", "", 0, 100};
  String mk = m["Kind"] | "auto"; if (mk != "auto" && mk.length()) r.kind = mk;
  String mu = m["Unit"] | ""; if (mu.length()) r.unit = mu;
  r.min = !m["Min"].isNull() ? (double)m["Min"] : p.hasMin ? p.min : r.min;
  r.max = !m["Max"].isNull() ? (double)m["Max"] : p.hasMax ? p.max : r.max;
  String t = m["Title"] | ""; t.trim(); r.title = t.length() ? t : p.field;
  return r;
}

FieldLook fieldLook(const Field& p) {
  Lock l;
  FieldLook o;
  JsonObjectConst m = g_raw["Fields"][p.child + "." + p.field];
  Resolved r = resolve(p, m);
  String t = g_raw["Devices"][p.child]["Title"] | ""; t.trim();
  o.devTitle = t.length() ? t : p.child; o.label = r.title; o.unit = r.unit;
  if (r.kind == "tank" || r.kind == "gauge") {
    if (!m["Low"].isNull()) { o.hasLow = true; o.low = m["Low"]; }
    if (!m["High"].isNull()) { o.hasHigh = true; o.high = m["High"]; }
  }
  return o;
}

String configMessage() {
  Lock l;
  JsonDocument d(&s_alloc);
  d["gw"] = g_cfg.device;
  d["solution"] = g_cfg.solution;
  JsonArray devs = d["devices"].to<JsonArray>();
  JsonObjectConst fm = g_raw["Fields"], dm = g_raw["Devices"];
  std::vector<String> order;
  for (auto& p : g_cfg.pack) { bool seen = false; for (auto& o : order) if (o == p.child) seen = true; if (!seen) order.push_back(p.child); }
  for (auto& child : order) {
    JsonObject dev = devs.add<JsonObject>();
    JsonObjectConst meta = dm[child];
    String title = meta["Title"] | ""; title.trim();
    dev["id"] = child; dev["name"] = title.length() ? title : child;
    String tpl = meta["Template"] | ""; if (tpl.length()) dev["icon"] = tpl;
    String color = meta["Color"] | ""; if (color.length()) dev["color"] = color;
    JsonArray fields = dev["fields"].to<JsonArray>();
    for (auto& p : g_cfg.pack) {
      if (p.child != child) continue;
      JsonObjectConst m = fm[child + "." + p.field];
      Resolved r = resolve(p, m);
      bool writable = p.access != Access::Read;
      bool ranged = r.kind == "tank" || r.kind == "gauge" || r.kind == "slider";
      JsonObject o = fields.add<JsonObject>();
      o["key"] = p.wire; o["lbl"] = r.title;
      if (r.unit.length()) o["unit"] = r.unit;
      o["widget"] = r.kind == "toggle" ? "switch" : r.kind == "slider" ? "slider" : r.kind == "number" ? "kpi" : r.kind == "tank" ? "tank" : "gauge";
      if (writable) o["writable"] = true;
      if (ranged) { o["min"] = r.min; o["max"] = r.max; }
      else { if (p.hasMin) o["min"] = p.min; if (p.hasMax) o["max"] = p.max; }
      if (r.kind == "toggle") { String on = m["OnText"] | "", off = m["OffText"] | ""; if (on.length()) o["on"] = on; if (off.length()) o["off"] = off; }
      // Phản hồi thật: field đầu vào (DI nối cảm biến/relay) cùng thiết bị → gửi khoá wire để webapp đối chiếu lệnh với trạng thái thực.
      if (r.kind == "toggle" && writable) {
        String fbf = m["Feedback"] | "";
        if (fbf.length() && fbf != p.field) for (auto& q : g_cfg.pack) if (q.child == child && q.field == fbf) { o["fb"] = q.wire; break; }
      }
      if (r.kind == "tank" || r.kind == "gauge") { if (!m["Low"].isNull()) o["low"] = m["Low"]; if (!m["High"].isNull()) o["high"] = m["High"]; }
    }
  }
  String out; serializeJson(d, out);
  return out;
}
