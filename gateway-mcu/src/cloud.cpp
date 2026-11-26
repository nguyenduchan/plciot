// Cầu nối cloud — chạy ĐỘC LẬP trên board, cùng logic với gateway C#:
//   CloudBridge.cs  : MQTTS (TLS, ghim chứng chỉ CloudPinSha256), LWT "offline" retain, đồng bộ lại status/config khi nối,
//                     telemetry theo TelemetryGate (có người xem / không ai xem / vừa có lệnh), chưa có user thì không gửi data.
//   ScadaHost.cs    : lệnh cloud phải có chữ ký server (CloudCmdKey), chống phát lại (ts ± CmdMaxAgeSec, id đã thấy),
//                     sys:claimed/unclaimed/live, lệnh theo khoá {id,child,key,v}, giới hạn RemoteCmdPerSec, ack lên <base>/ack.
//   MainForm.cs     : đăng ký (register, bằng phiên webapp admin chuyển xuống) / enroll (QR), áp kit, hỏi lại cấu hình server định kỳ.
#include "gw.h"
#include <ETH.h>
#include <NetworkClientSecure.h>
#include <PubSubClient.h>
#include <esp_http_client.h>
#include <esp_crt_bundle.h>
#include <mbedtls/base64.h>
#include <sys/time.h>
#include <time.h>

namespace {
NetworkClientSecure s_tls;
PubSubClient s_mqtt(s_tls);
enum class St { Disabled, Disconnected, Connecting, Connected } s_state = St::Disabled;
bool s_restart = false, s_ntpStarted = false;
uint32_t s_nextTry = 0, s_backoff = 2000;
uint32_t s_lastTele = 0, s_expediteUntil = 0, s_liveUntil = 0;
uint32_t s_lastSeq = 0; bool s_telePending = false;
String s_lastStatus;
uint32_t s_nextRefresh = 0, s_nextBackfill = 0;
std::map<String, uint32_t> s_seenIds;   // id lệnh → millis (chặn phát lại)
uint32_t s_rateSec = 0; int s_rateCount = 0;

String base() { return "gw/" + g_cfg.mqttId; }
}  // namespace
/// Logic tại biên vừa đổi đầu ra: gửi telemetry ngay (không chờ chu kỳ gửi chậm khi không ai xem webapp).
void cloudExpedite() { s_expediteUntil = millis() + 3000; }
namespace {
// thông số kết nối cloud lúc nối gần nhất: cấu hình đổi mà các thông số này giữ nguyên thì KHÔNG nối lại (xem cloudRestart)
String s_connKey;
bool s_republish = false;
String connKey() {
  String pw = cloudPassword();
  return g_cfg.mobile + "|" + g_cfg.cloudHost + "|" + String(g_cfg.cloudPort) + "|" + g_cfg.cloudUser + "|" + g_cfg.cloudPin + "|" + g_cfg.mqttId + "|" + sha256Hex((const uint8_t*)pw.c_str(), pw.length());
}
bool live() { return (int32_t)(s_liveUntil - millis()) > 0; }

bool mqttIdOk(const String& s) {
  if (s.length() != 16) return false;
  for (char c : s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

void publish(const char* kind, const String& payload, bool retain) {
  if (!s_mqtt.connected()) return;
  String t = base() + "/" + kind;
  if (!s_mqtt.publish(t.c_str(), (const uint8_t*)payload.c_str(), payload.length(), retain)) logf("Gửi %s lỗi (%u byte)", t.c_str(), payload.length());
}

String ack(const String& id, bool ok, const String& err = "") {
  JsonDocument d;
  if (id.length()) d["id"] = id; else d["id"] = nullptr;
  d["ok"] = ok;
  if (err.length()) d["err"] = err;
  String s; serializeJson(d, s); return s;
}
void sendAck(const String& json) { logf("GW→Cloud ack %s", json.c_str()); publish("ack", json, false); }
void reject(const String& id, const String& err) { logf("Từ chối lệnh từ cloud: %s", err.c_str()); sendAck(ack(id, false, err)); }

/// TelemetryGate.GapMs: vừa có lệnh → 0; có người xem → minMs; không ai xem → max(idleMs, minMs); idleMs ≤ 0 → minMs.
uint32_t gapMs() {
  if ((int32_t)(s_expediteUntil - millis()) > 0) return 0;
  if (g_cfg.idleMs <= 0 || live()) return g_cfg.teleMinMs;
  return max(g_cfg.idleMs, g_cfg.teleMinMs);
}

bool takeToken() {
  uint32_t sec = millis() / 1000;
  if (sec != s_rateSec) { s_rateSec = sec; s_rateCount = 0; }
  return ++s_rateCount <= max(1, g_cfg.remoteCmdPerSec);
}

/// Chống phát lại: "ts" lệch quá CmdMaxAgeSec → stale_cmd; id đã thấy trong 5 phút → replayed_cmd.
String checkReplay(JsonObjectConst r, const String& id) {
  if (g_cfg.cmdMaxAgeSec > 0 && r["ts"].is<long long>()) {
    if (!timeSynced()) return "clock_not_synced";   // không biết giờ thì không kiểm được độ tươi của lệnh → từ chối (an toàn)
    long long d = nowMs() - r["ts"].as<long long>();
    if (llabs(d) > (long long)g_cfg.cmdMaxAgeSec * 1000) { logf("Từ chối lệnh cũ/lệch đồng hồ: lệch %lld s", d / 1000); return "stale_cmd"; }
  }
  if (id.length() == 0) return "";
  uint32_t now = millis();
  for (auto it = s_seenIds.begin(); it != s_seenIds.end();) { if (now - it->second > 300000) it = s_seenIds.erase(it); else ++it; }
  if (s_seenIds.count(id)) return "replayed_cmd";
  if (s_seenIds.size() >= 512) return "rate_limited";
  s_seenIds[id] = now;
  return "";
}

// ---------------------------------------------------------------- cài đặt từ xa (GatewayAdmin → server → gw/<id>/rpc, docs/REMOTE-ADMIN.md)
// Board không giải nén gzip: server gửi thân dạng base64 thường ("enc":"b64", nằm trong phần được ký) và board trả "enc":"b64".
String b64enc(const String& s) {
  size_t n = 0;
  mbedtls_base64_encode(nullptr, 0, &n, (const uint8_t*)s.c_str(), s.length());
  std::vector<uint8_t> o(n + 1);
  if (mbedtls_base64_encode(o.data(), o.size(), &n, (const uint8_t*)s.c_str(), s.length())) return "";
  String r; r.concat((const char*)o.data(), n); return r;
}
bool b64dec(const String& s, String& out) {
  size_t n = 0;
  std::vector<uint8_t> o(s.length() * 3 / 4 + 4);
  if (mbedtls_base64_decode(o.data(), o.size(), &n, (const uint8_t*)s.c_str(), s.length())) return false;
  out = ""; out.concat((const char*)o.data(), n); return true;
}

/// Trả lời chia phần ≤ 3000 ký tự (đường ingest của server chặn gói > 4 KB).
void rpcReply(const String& rid, int st, const String& body) {
  const unsigned kPart = 3000;
  String z = b64enc(body);
  int n = max<int>(1, (z.length() + kPart - 1) / kPart);
  for (int i = 0; i < n; i++) {
    JsonDocument d;
    d["rid"] = rid; d["i"] = i; d["n"] = n; d["st"] = st; d["enc"] = "b64";
    d["z"] = z.substring(i * kPart, min<unsigned>(z.length(), (i + 1) * kPart));
    String s; serializeJson(d, s); publish("rpcr", s, false);
  }
}

void onRpc(const String& raw) {
  if (!g_cfg.cmdKey.length()) { logf("Bỏ yêu cầu cài đặt từ xa: chưa có khoá ký của server"); return; }
  String plain;
  if (!verifySigned("rpc1", raw, g_cfg.mqttId, g_cfg.cmdKey, plain)) {
    logf("Từ chối cài đặt từ xa: thiếu/sai chữ ký server");
    evLog("rpc_badsig", "Yêu cầu cài đặt từ xa sai chữ ký server — bị từ chối", true);
    return;
  }
  JsonDocument d;
  if (deserializeJson(d, plain)) return;
  String rid = d["rid"] | "";
  if (!rid.length() || rid.length() > 64) return;
  if (!timeSynced()) { rpcReply(rid, 503, "{\"Ok\":false,\"Err\":\"clock_not_synced\"}"); return; }
  long long dt = nowMs() - (d["ts"] | 0LL);
  if (llabs(dt) > 60000) { rpcReply(rid, 401, "{\"Ok\":false,\"Err\":\"stale_rpc\"}"); return; }
  uint32_t now = millis();
  for (auto it = s_seenIds.begin(); it != s_seenIds.end();) { if (now - it->second > 300000) it = s_seenIds.erase(it); else ++it; }
  String key = "rpc:" + rid;
  if (s_seenIds.count(key)) return;   // phát lại: im lặng
  s_seenIds[key] = now;
  String b = d["b"] | "", enc = d["enc"] | "", body;
  if (b.length() && (enc != "b64" || !b64dec(b, body))) { rpcReply(rid, 415, "{\"Ok\":false,\"Err\":\"bad_body_encoding\"}"); return; }
  String m = d["m"] | "", p = d["p"] | "", adm = d["adm"] | "", appr = d["appr"] | "", resp;
  int st = apiRpc(m, p, body, adm, appr, resp);
  logf("Cài đặt từ xa (%s): %s %s → %d", adm.c_str(), m.c_str(), p.c_str(), st);
  rpcReply(rid, st, resp);
}

void onMessage(char* topic, uint8_t* payload, unsigned int len) {
  if (String(topic) == base() + "/rpc") { if (len > 0 && len <= 16000) onRpc(String((const char*)payload, len)); return; }
  if (String(topic) != base() + "/cmd" || len == 0) return;
  if (len > 1024) { logf("Cloud→GW: bỏ lệnh quá dài (%u byte)", len); return; }
  String raw((const char*)payload, len);
  if (raw.indexOf("\"sys\":\"live\"") < 0) logf("Cloud→GW %s", raw.c_str());   // nhật ký lệnh như gateway C# (bỏ nhịp "đang xem" cho đỡ rối)
  bool trusted = false;
  if (g_cfg.cmdKey.length()) {
    String plain;
    if (!verifyCmd(raw, g_cfg.mqttId, g_cfg.cmdKey, plain)) {
      JsonDocument d; deserializeJson(d, raw);
      logf("Từ chối lệnh cloud: thiếu/sai chữ ký của server");
      reject(d["id"].is<const char*>() ? String(d["id"].as<const char*>()) : String(""), "bad_sig");
      return;
    }
    raw = plain; trusted = true;
  }
  JsonDocument d;
  if (deserializeJson(d, raw) || !d.is<JsonObject>()) { reject("", "bad_json"); return; }
  JsonObjectConst r = d.as<JsonObjectConst>();
  String id = r["id"].is<const char*>() ? String(r["id"].as<const char*>()) : r["id"].isNull() ? String("") : r["id"].as<String>();
  String rep = checkReplay(r, id);
  if (rep.length()) { reject(id, rep); return; }
  if (r["sys"].is<const char*>()) {   // tín hiệu hệ thống từ server, không phải lệnh PLC
    String sys = r["sys"].as<const char*>();
    if (sys == "claimed" || sys == "unclaimed") {
      bool on = sys == "claimed";
      { Lock l; g_raw["Config"]["CloudSendData"] = on; } storeSave(); storeApply();
      logf(on ? "Server báo tem đã có user — bắt đầu gửi data lên cloud" : "Server báo tem không còn user — ngừng gửi data, chỉ đồng bộ setting");
    } else if (sys == "lock" || sys == "unlock") {
      if (!trusted) { logf("Bỏ lệnh %s không có chữ ký server", sys.c_str()); return; }   // chỉ server (khoá ký) mới khoá/mở được
      setLocked(sys == "lock", r["reason"] | "server");
    } else if (sys == "ota_allow") {
      // chủ trạm bấm "Cho phép cập nhật" trên webapp (đã qua Face ID/TOTP ở server) — chỉ nhận khi có chữ ký server
      if (!trusted) { logf("Bỏ ota_allow không có chữ ký server"); return; }
      otaAllow(r["ttl"] | 900, String(r["by"] | ""));
    } else if (sys == "live") {
      int ttl = constrain((int)(r["ttl"] | 60), 5, 600);
      if (!live()) logf("Có người xem webapp — gửi dữ liệu nhanh");
      s_liveUntil = millis() + ttl * 1000UL;
    }
    return;
  }
  s_expediteUntil = millis() + 3000;   // trạng thái PLC sau lệnh phải lên webapp ngay
  if (!r["key"].is<const char*>()) { reject(id, "use_key_command"); return; }   // board đọc theo field (Pack), không nhận lệnh thanh ghi thô
  if (!trusted) { reject(id, "otp_required"); return; }                          // không có khoá server: board không có cách mở khoá cục bộ → không nhận điều khiển
  if (!g_cfg.remoteControl()) { reject(id, "remote_disabled"); return; }
  if (!takeToken()) { reject(id, "rate_limited"); return; }
  if (!r["v"].is<double>()) { sendAck(ack(id, false, "bad_value")); return; }
  String e = engineWrite(r["child"] | "", r["key"].as<const char*>(), r["v"].as<double>(), true);
  sendAck(ack(id, e.length() == 0, e));
}

// ---------------------------------------------------------------- HTTPS tới server (chứng chỉ kiểm bằng bộ CA của ESP-IDF)
struct HttpBuf { String body, date; };
esp_err_t httpEvent(esp_http_client_event_t* e) {
  auto* b = (HttpBuf*)e->user_data;
  if (e->event_id == HTTP_EVENT_ON_DATA && b->body.length() < 65536) b->body.concat((const char*)e->data, e->data_len);
  if (e->event_id == HTTP_EVENT_ON_HEADER && strcasecmp(e->header_key, "Date") == 0) b->date = e->header_value;
  return ESP_OK;
}

/// Lấy giờ từ header Date của server khi chưa có NTP (đủ chính xác cho chữ ký ±5 phút và lệnh ±10 giây sau khi NTP chạy).
void timeFromDate(const String& date) {
  if (timeSynced() || date.length() < 25) return;
  static const char* M = "JanFebMarAprMayJunJulAugSepOctNovDec";
  char mon[4] = {0}; struct tm t = {};
  if (sscanf(date.c_str() + 5, "%d %3s %d %d:%d:%d", &t.tm_mday, mon, &t.tm_year, &t.tm_hour, &t.tm_min, &t.tm_sec) != 6) return;
  const char* p = strstr(M, mon); if (!p) return;
  t.tm_mon = (p - M) / 3; t.tm_year -= 1900;
  setenv("TZ", "UTC0", 1); tzset();
  struct timeval tv = {mktime(&t), 0};
  settimeofday(&tv, nullptr);
  rtcNoteNetTime();   // RTC chưa có giờ hợp lệ (nên mới tới đây) → ghi giờ server xuống RTC
  logf("Đặt giờ theo server: %s", date.c_str());
}

/// HTTPS (chứng chỉ CA của ESP-IDF) tới VPS, hoặc http:// tới server cài trên PC trong LAN (trường hợp offline, không có CA công khai).
int httpsJson(const String& url, const String& body, const String& bearer, String& resp, bool get = false) {
  HttpBuf b;
  esp_http_client_config_t c = {};
  c.url = url.c_str(); c.method = get ? HTTP_METHOD_GET : HTTP_METHOD_POST; c.timeout_ms = 30000;
  c.crt_bundle_attach = esp_crt_bundle_attach; c.event_handler = httpEvent; c.user_data = &b;
  esp_http_client_handle_t h = esp_http_client_init(&c);
  if (!h) return -1;
  esp_http_client_set_header(h, "Content-Type", "application/json");
  esp_http_client_set_header(h, "X-Gateway-Version", FW_VERSION);
  esp_http_client_set_header(h, "X-Gateway-Kind", "mcu");
  String auth = "Bearer " + bearer;
  if (bearer.length()) esp_http_client_set_header(h, "Authorization", auth.c_str());
  if (!get) esp_http_client_set_post_field(h, body.c_str(), body.length());
  esp_err_t e = esp_http_client_perform(h);
  int st = e == ESP_OK ? esp_http_client_get_status_code(h) : -1;
  esp_http_client_cleanup(h);
  timeFromDate(b.date);
  resp = b.body;
  if (e != ESP_OK) logf("HTTPS %s lỗi: %s", url.c_str(), esp_err_to_name(e));
  return st;
}

String apiBase(const String& api) { String a = api.length() ? api : g_cfg.apiUrl; a.trim(); while (a.endsWith("/")) a.remove(a.length() - 1); return a.length() ? a : String("https://plc.dieukhientudong.net"); }

String errorOf(const String& resp, int st) {
  JsonDocument d; deserializeJson(d, resp);
  return d["error"].is<const char*>() ? String(d["error"].as<const char*>()) : "HTTP " + String(st);
}

/// site/device trong QR (base64url JSON hoặc link …?claim=…) — GatewayIdentity.SiteDeviceOfQr.
bool siteDeviceOfQr(const String& qr, String& site, String& device) {
  String raw = qr; raw.trim();
  int i = raw.indexOf("claim=");
  if (i >= 0) {
    raw = raw.substring(i + 6); int amp = raw.indexOf('&'); if (amp >= 0) raw = raw.substring(0, amp);
    String dec; for (size_t k = 0; k < raw.length(); k++) {
      if (raw[k] == '%' && k + 2 < raw.length()) { dec += (char)strtol(raw.substring(k + 1, k + 3).c_str(), nullptr, 16); k += 2; } else dec += raw[k];
    }
    raw = dec;
  }
  String json = raw;
  if (!raw.startsWith("{")) { auto b = fromB64u(raw); json = String((const char*)b.data(), b.size()); }
  JsonDocument d;
  if (deserializeJson(d, json)) return false;
  site = d["site"] | ""; device = d["device"] | "";
  return site.length() && device.length();
}

/// Áp kit server trả (ApplyKitAsync của GatewayApp): site/device, id MQTT, tài khoản MQTT, ghim chứng chỉ, khoá ký lệnh, gói cloud.
bool applyKit(JsonObjectConst kit, const String& qr, const String& api, String& msg) {
  String mqttId = kit["mqttId"] | "";
  if (!mqttId.length()) { String tb = kit["topicBase"] | ""; if (tb.startsWith("gw/")) mqttId = tb.substring(3); }
  if (!mqttIdOk(mqttId)) { msg = "server không cấp id MQTT hợp lệ"; return false; }
  int nPack = 0; bool kept = false;
  {
    Lock l;
    JsonObject c = g_raw["Config"];
    c["GatewayQr"] = qr; c["CloudApiUrl"] = apiBase(api);
    if (kit["cmdKey"].is<const char*>() && strlen(kit["cmdKey"])) c["CloudCmdKey"] = String(kit["cmdKey"].as<const char*>());
    c["CloudSendData"] = kit["claimed"].isNull() ? true : kit["claimed"].as<bool>();
    if (kit["site"].is<const char*>()) c["Site"] = String(kit["site"].as<const char*>());
    if (kit["device"].is<const char*>()) c["Device"] = String(kit["device"].as<const char*>());
    c["MqttId"] = mqttId;
    if (kit["solution"].is<const char*>()) c["Solution"] = String(kit["solution"].as<const char*>());
    if (kit["storeEveryMs"].is<int>() && kit["storeEveryMs"].as<int>() >= 0) c["CloudIdleTelemetryMs"] = kit["storeEveryMs"].as<int>();
    if (kit["retentionDays"].is<int>() && kit["retentionDays"].as<int>() >= 0) c["CloudRetentionDays"] = kit["retentionDays"].as<int>();
    if (kit["telemetryMinMs"].is<int>() && kit["telemetryMinMs"].as<int>() > 0) { c["CloudTelemetryMinMs"] = kit["telemetryMinMs"].as<int>(); c["CloudTelemetryFastMs"] = kit["telemetryMinMs"].as<int>(); }
    JsonObjectConst m = kit["mqtt"];
    if (!m.isNull()) {
      if (m["username"].is<const char*>()) c["CloudUser"] = String(m["username"].as<const char*>());
      if (m["password"].is<const char*>()) setCloudPassword(m["password"].as<const char*>());
      String pin = m["pinSha256"] | ""; pin.replace(":", ""); pin.trim(); if (pin.length()) c["CloudPinSha256"] = pin;
      String u = m["mqtts"] | "";   // mqtts://host:port
      int s = u.indexOf("://"); if (s >= 0) u = u.substring(s + 3);
      int colon = u.lastIndexOf(':');
      if (colon > 0) { c["CloudHost"] = u.substring(0, colon); c["CloudPort"] = u.substring(colon + 1).toInt(); c["CloudTransport"] = "mqtts"; }
    }
    c["Mobile"] = "Control";
    // Pack: đã tự khai báo đủ (thanh ghi + giao thức) trước khi đăng ký → giữ nguyên; chưa thì lấy danh sách field từ tem (để admin khai báo sau)
    JsonArray pack = c["Pack"];
    bool allDeclared = pack.size() > 0;
    for (JsonObject p : pack) if ((int)(p["Address"] | -1) < 0) allDeclared = false;
    if (allDeclared) { kept = true; nPack = pack.size(); }
    else {
      JsonArray np = c["Pack"].to<JsonArray>();
      for (JsonObjectConst ch : kit["pack"].as<JsonArrayConst>())
        for (JsonVariantConst f : ch["fields"].as<JsonArrayConst>()) {
          JsonObject p = np.add<JsonObject>();
          String fname = f.as<String>();
          p["Child"] = String(ch["id"] | ""); p["Field"] = fname; p["Address"] = -1; p["Scale"] = 0;
          JsonObjectConst lim = ch["limits"][fname];
          if (!lim.isNull()) { p["Min"] = lim["min"]; p["Max"] = lim["max"]; }
          nPack++;
        }
    }
  }
  storeSave(); storeApply(); engineRestart(); s_restart = true; g_rev++;
  msg = kept ? "Đã đăng ký " + g_cfg.site + "/" + g_cfg.device + "; giữ nguyên " + String(nPack) + " field đã khai báo."
             : "Enroll xong: " + g_cfg.site + "/" + g_cfg.device + ", " + String(nPack) + " field. Khai báo giao thức/thanh ghi ở trang Thiết bị.";
  logf("%s", msg.c_str());
  return true;
}

bool doRegister(const String& api, const String& loginJson, String& msg) {
  JsonDocument l;
  if (deserializeJson(l, loginJson)) { msg = "phiên đăng nhập không hợp lệ"; return false; }
  // LoginResult của C# (Token, User, Uid); chấp nhận cả tên viết thường
  auto pick = [&](const char* a, const char* b) { return l[a].isNull() ? l[b] : l[a]; };
  String token = pick("Token", "token") | ""; long long uid = pick("Uid", "uid") | 0LL; String user = pick("User", "user") | "";
  if (!token.length()) { msg = "phiên đăng nhập không hợp lệ"; return false; }
  if (!timeSynced()) { String dummy; httpsJson(apiBase(api) + "/api/v1/gateway/login/start", "{}", "", dummy); }   // lấy giờ từ header Date
  long long ts = nowMs();
  JsonDocument body;
  body["fp"] = fingerprint(); body["pubkey"] = idPublicKey(); body["ts"] = ts;
  body["sig"] = idSign("register|" + String(uid) + "|" + String(ts));
  body["solution"] = g_cfg.solution;
  JsonDocument cfgMsg; deserializeJson(cfgMsg, configMessage()); body["config"] = cfgMsg;
  String req, resp; serializeJson(body, req);
  int st = httpsJson(apiBase(api) + "/api/v1/gateway/register", req, token, resp);
  if (st < 200 || st >= 300) {
    String e = st < 0 ? "không nối được server" : errorOf(resp, st);
    if (e == "device_blocked") { setLocked(true, "server"); msg = "Thiết bị đã bị khoá (báo mất) — liên hệ nhà cung cấp."; return false; }
    msg = e == "too_many_gateways" ? "Tài khoản đã đạt số gateway tối đa." : e == "invalid_proof" ? "Đồng hồ board lệch quá 5 phút so với server." :
          e == "unauthorized" || e == "session_revoked" ? "Phiên đăng nhập hết hạn — đăng nhập lại." : "Kết nối lỗi: " + e;
    return false;
  }
  JsonDocument r; deserializeJson(r, resp);
  if (r["approved"] == true && r["kit"].is<JsonObject>() && r["qr"].is<const char*>()) {
    logf("Đã đăng ký: %s/%s, tài khoản %s, ID máy %s", (const char*)(r["site"] | ""), (const char*)(r["device"] | ""), user.c_str(), idHw().c_str());
    return applyKit(r["kit"], r["qr"].as<const char*>(), api, msg);
  }
  String status = r["status"] | "";
  if (status == "transfer_pending") { msg = "Gateway đang thuộc tài khoản khác. Đã gửi yêu cầu chuyển sang \"" + user + "\" — chủ cũ duyệt trên webapp thì chuyển ngay."; return true; }
  if (status == "transfer_done") { msg = "Đã chuyển gateway sang tài khoản \"" + user + "\"."; return true; }
  msg = "Server chưa cấp gateway cho tài khoản này.";
  return false;
}

bool doEnroll(const String& api, const String& qr, String& msg) {
  String site, device;
  if (!siteDeviceOfQr(qr, site, device)) { msg = "Mã QR không đúng định dạng."; return false; }
  if (!timeSynced()) { String dummy; httpsJson(apiBase(api) + "/api/v1/gateway/login/start", "{}", "", dummy); }
  long long ts = nowMs();
  JsonDocument body;
  body["qr"] = qr; body["hw"] = idHw(); body["ts"] = ts; body["rotateMqtt"] = false;
  body["sig"] = idSign("enroll|" + site + "|" + device + "|" + String(ts));
  String req, resp; serializeJson(body, req);
  int st = httpsJson(apiBase(api) + "/api/v1/gateway/enroll", req, "", resp);
  if (st < 200 || st >= 300) {
    if (st > 0 && errorOf(resp, st) == "device_blocked") { setLocked(true, "server"); msg = "Thiết bị đã bị khoá (báo mất) — liên hệ nhà cung cấp."; return false; }
    msg = "Enroll lỗi: " + (st < 0 ? String("không nối được server") : errorOf(resp, st)); return false;
  }
  JsonDocument kit; deserializeJson(kit, resp);
  return applyKit(kit.as<JsonObjectConst>(), qr, api, msg);
}

/// PollClaimed của GatewayApp: hỏi lại server (có chữ ký) — tem đã có user chưa, khoá ký lệnh mới, gói cloud đổi.
void refreshConfig() {
  if (!g_cfg.qr.length() || !g_cfg.mqttId.length()) return;
  String site, device;
  if (!siteDeviceOfQr(g_cfg.qr, site, device)) { site = g_cfg.site; device = g_cfg.device; }
  long long ts = nowMs();
  JsonDocument body;
  body["qr"] = g_cfg.qr; body["hw"] = idHw(); body["ts"] = ts; body["includeCredentials"] = false;
  body["sig"] = idSign("config|" + site + "|" + device + "|" + String(ts));
  String req, resp; serializeJson(body, req);
  int st = httpsJson(apiBase("") + "/api/v1/gateway/config", req, "", resp);
  if (st < 200 || st >= 300) {
    if (st > 0 && errorOf(resp, st) == "device_blocked") setLocked(true, "server");   // admin khoá theo mã phần cứng
    if (st > 0) logf("Hỏi cấu hình server lỗi: %s", errorOf(resp, st).c_str());
    return;
  }
  if (g_locked) setLocked(false, "");   // server không còn chặn máy này → mở khoá
  JsonDocument k; if (deserializeJson(k, resp)) return;
  bool changed = false;
  {
    Lock l;
    JsonObject c = g_raw["Config"];
    // chuỗi: CHÉP (String) — gán const char* chỉ lưu con trỏ vào tài liệu tạm k, lần lưu sau sẽ ghi rác (lỗi đã gặp ở applyKit)
    auto setIf = [&](const char* key, JsonVariantConst v) {
      if (v.isNull() || c[key] == v) return;
      if (v.is<const char*>()) c[key] = String(v.as<const char*>()); else c[key] = v;
      changed = true;
    };
    if (k["cmdKey"].is<const char*>() && strlen(k["cmdKey"])) setIf("CloudCmdKey", k["cmdKey"]);
    if (k["storeEveryMs"].is<int>() && k["storeEveryMs"].as<int>() >= 0) setIf("CloudIdleTelemetryMs", k["storeEveryMs"]);
    if (k["retentionDays"].is<int>() && k["retentionDays"].as<int>() >= 0) setIf("CloudRetentionDays", k["retentionDays"]);
    if (k["claimed"].is<bool>()) setIf("CloudSendData", k["claimed"]);
    if (k["solution"].is<const char*>()) setIf("Solution", k["solution"]);
  }
  if (changed) { storeSave(); storeApply(); g_rev++; logf("Cấu hình từ server đã đổi (gói / khoá ký / user)"); }
}

// ---------------------------------------------------------------- MQTTS
String certSha256() {
  const mbedtls_x509_crt* crt = s_tls.getPeerCertificate();
  return crt ? sha256Hex(crt->raw.p, crt->raw.len) : String("");
}

bool connectMqtt() {
  String pass = cloudPassword();
  if (!g_cfg.cloudPin.length()) { logf("Cloud: thiếu dấu vân tay chứng chỉ broker (CloudPinSha256) — đăng ký lại để server cấp"); return false; }
  s_tls.stop();
  s_tls.setInsecure();                    // kiểm bằng ghim chứng chỉ ngay sau bắt tay (broker tự ký), như ValidateServerCert của C#
  s_tls.setHandshakeTimeout(10);
  if (!s_tls.connect(g_cfg.cloudHost.c_str(), g_cfg.cloudPort)) { logf("Cloud: không nối được %s:%d", g_cfg.cloudHost.c_str(), g_cfg.cloudPort); return false; }
  String pin = g_cfg.cloudPin; pin.toLowerCase();
  if (certSha256() != pin) { logf("Cloud: chứng chỉ broker KHÔNG khớp dấu vân tay đã ghim — ngắt"); s_tls.stop(); return false; }
  String id = "scada-" + g_cfg.site + "-" + g_cfg.device + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  String will = base() + "/status";
  // PubSubClient chỉ giữ CON TRỎ tới tên host: dùng bản sao tĩnh, không trỏ vào g_cfg (bị thay khi cấu hình đổi)
  static String s_mqttHost; s_mqttHost = g_cfg.cloudHost;
  s_mqtt.setServer(s_mqttHost.c_str(), g_cfg.cloudPort);
  if (!s_mqtt.connect(id.c_str(), g_cfg.cloudUser.c_str(), pass.c_str(), will.c_str(), 1, true, "offline", true)) {
    logf("Cloud từ chối: mã %d", s_mqtt.state()); s_tls.stop(); return false;
  }
  s_mqtt.subscribe((base() + "/cmd").c_str(), 0);
  s_mqtt.subscribe((base() + "/rpc").c_str(), 1);   // cài đặt từ xa (GatewayAdmin): chương trình logic, xem trạng thái/nhật ký
  s_connKey = connKey();
  logf("Đã nối cloud %s:%d (mqtts, TLS, chứng chỉ đã ghim)", g_cfg.cloudHost.c_str(), g_cfg.cloudPort);
  // đồng bộ lại trạng thái hiện tại lên cloud (các bản tin retain)
  s_lastStatus = g_status == "plc_fault" ? "plc_fault" : "online";
  publish("status", s_lastStatus, true);
  publish("config", configMessage(), true);
  s_telePending = true;
  return true;
}
}  // namespace

bool timeSynced() { return time(nullptr) > 1700000000; }
int64_t nowMs() { struct timeval tv; gettimeofday(&tv, nullptr); return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000; }

String cloudStateName() {
  switch (s_state) { case St::Connected: return "Connected"; case St::Connecting: return "Connecting"; case St::Disconnected: return "Disconnected"; default: return "Disabled"; }
}

void cloudBegin() {
  s_mqtt.setBufferSize(16384 + 512);    // bản tin config tối đa 16 KB (max_packet_size của broker)
  s_mqtt.setKeepAlive(30);
  s_mqtt.setSocketTimeout(10);
  s_mqtt.setCallback(onMessage);
}

/// Cấu hình đổi: CHỈ nối lại khi thông số kết nối cloud đổi (như gateway C# không ngắt cloud khi tạm dừng thiết bị) —
/// đổi khác (thiết bị, nhãn, chu kỳ…) chỉ gửi lại bản tin config, webapp không thấy gateway "offline" chớp nhoáng.
bool cloudLinkOk() { return s_mqtt.connected(); }   // MQTT đang nối = đường mạng hiện tại ra được Internet
void cloudRestart() {
  String k = connKey();
  if (k != s_connKey) s_restart = true; else s_republish = true;
}

bool cloudAction(const String& action, const String& api, const String& value, String& msg) {
  if (!netUp()) { msg = "Board chưa có mạng."; return false; }
  if (action == "register") return doRegister(api, value, msg);
  if (action == "enroll") return doEnroll(api, value, msg);
  msg = action == "password" ? "Gateway Waveshare không dùng mật khẩu: PC admin được ghép bằng nút BOOT (hoặc đăng nhập webapp), sau đó vào tự động."
      : action == "migrate" ? "Board không chuyển được sang máy khác — đăng ký lại board mới." : "việc cloud không hợp lệ";
  return false;
}

bool cloudOwnsBoard(const String& webToken, String& why) {
  if (!mqttIdOk(g_cfg.mqttId)) { why = "board_not_registered"; return false; }   // chưa đăng ký server nào: chỉ ghép được bằng nút BOOT
  if (!netUp()) { why = "server_unreachable"; return false; }
  String resp;
  int st = httpsJson(apiBase("") + "/api/v1/gateway/mine", "", webToken, resp, true);
  if (st < 0) { why = "server_unreachable"; return false; }
  if (st != 200) { why = errorOf(resp, st); return false; }
  JsonDocument d;
  if (deserializeJson(d, resp)) { why = "bad_response"; return false; }
  for (JsonObjectConst g : d["gateways"].as<JsonArrayConst>())
    if (g_cfg.site == (g["site"] | "") && g_cfg.device == (g["device"] | "")) return true;
  why = "not_owner";
  return false;
}

void cloudLoop() {
#ifdef FW_TEST_BREAK_CLOUD
  return;   // CHỈ bản thử quay về firmware cũ (build dev): giả lập firmware mới làm mất kết nối cloud
#endif
  bool hasIp = netUp();
  if (hasIp && !s_ntpStarted) { configTime(0, 0, "pool.ntp.org", "time.google.com"); s_ntpStarted = true; }

  // dữ liệu mới của vòng đọc: cảnh báo + hàng đợi gửi bù + đánh dấu cần gửi telemetry
  uint32_t seq = engineSeq();
  if (seq != s_lastSeq) {
    s_lastSeq = seq;
    String tele = engineTelemetry();
    if (tele.length()) {
      s_telePending = true;
      backfillRecord(tele, s_state == St::Connected);
      std::vector<String> fired; alertEvaluate(tele, fired);
      for (auto& a : fired) { logf("Cảnh báo: %s", a.c_str()); publish("alert", a, false); }   // cảnh báo tính tại gateway, server chỉ chuyển tiếp
    }
  }

  if (s_mqtt.connected()) {   // cảnh báo bảo mật (ghép PC lạ, nạp firmware chưa duyệt, quay về bản cũ…) → server đẩy thông báo đỏ cho chủ trạm
    String a;
    if (evNextAlert(a)) { publish("alert", a, false); evAlertSent(); }
  }

  bool want = hasIp && g_cfg.cloudOn() && mqttIdOk(g_cfg.mqttId) && g_cfg.cloudHost.length() && !leaseActive();   // chế độ gateway: PC là đường báo duy nhất
  if (s_restart) {
    s_restart = false;
    if (s_mqtt.connected()) { publish("status", "offline", true); s_mqtt.disconnect(); }
    s_tls.stop(); s_nextTry = 0; s_backoff = 2000;
  }
  if (s_republish) { s_republish = false; if (s_mqtt.connected()) { publish("config", configMessage(), true); s_telePending = true; } }
  if (!want) {
    if (s_mqtt.connected()) { if (leaseActive()) publish("status", "offline", true); s_mqtt.disconnect(); }
    if (leaseActive()) s_lastStatus = "";   // hết lease: nối lại sẽ báo trạng thái lại
    s_state = leaseActive() || !g_cfg.cloudOn() ? St::Disabled : St::Disconnected; return;
  }

  if (!s_mqtt.connected()) {
    if (s_state == St::Connected) logf("Mất kết nối cloud");
    s_state = St::Disconnected;
    if ((int32_t)(millis() - s_nextTry) < 0) return;
    s_state = St::Connecting;
    if (connectMqtt()) { s_state = St::Connected; s_backoff = 2000; s_nextRefresh = millis() + 5000; }
    else { s_state = St::Disconnected; s_nextTry = millis() + s_backoff; s_backoff = min<uint32_t>(s_backoff * 2, 30000); }
    return;
  }
  s_mqtt.loop();

  // status đổi (online ↔ plc_fault)
  String st = g_status == "plc_fault" ? "plc_fault" : "online";
  if (st != s_lastStatus) { s_lastStatus = st; publish("status", st, true); }

  // telemetry theo TelemetryGate; chưa có user → chỉ setting, không data
  if (s_telePending && g_cfg.sendData && !g_locked && millis() - s_lastTele >= gapMs()) {
    String tele = engineTelemetry();
    if (tele.length() && tele.length() <= 4096) { publish("telemetry", tele, true); s_lastTele = millis(); }
    s_telePending = false;
  }

  // gửi bù dữ liệu lúc offline: ~10 bản tin/giây, cũ nhất trước
  if (g_cfg.sendData && !g_locked && (int32_t)(millis() - s_nextBackfill) >= 0) {
    String p;
    if (backfillNext(p)) {
      String t = base() + "/telemetry";
      if (s_mqtt.publish(t.c_str(), (const uint8_t*)p.c_str(), p.length(), false)) backfillAck();
      s_nextBackfill = millis() + 100;
    } else s_nextBackfill = millis() + 6000;
  }

  // hỏi lại server: chưa có user thì dày (60 s), đã có thì thưa (5 phút)
  if ((int32_t)(millis() - s_nextRefresh) >= 0) { s_nextRefresh = millis() + (g_cfg.sendData ? 300000UL : 60000UL); refreshConfig(); }
}

/// GET HTTPS cho ota.cpp (thông tin bản firmware mới trên server).
int httpsGet(const String& url, String& resp) { return httpsJson(url, "", "", resp, true); }
