// CẬP NHẬT FIRMWARE CÓ DUYỆT + TỰ QUAY LẠI BẢN CŨ + NHẬT KÝ SỰ KIỆN (trạm không người trông).
//
// Chìa khoá 2 lớp:
//   1. CHỮ KÝ của nhà phát triển: chỉ cài bản có chữ ký `fw1|<sha256>|<phiên bản>` khớp khoá công khai gắn cứng (fwkey.h).
//   2. CHỦ TRẠM DUYỆT: board đã gắn tài khoản (có khoá ký của server) chỉ nhận cập nhật trong 15 phút sau khi chủ bấm
//      "Cho phép cập nhật" trên webapp (server gửi {sys:"ota_allow"} có chữ ký). Hết cửa sổ / cài xong → đóng lại.
//      Board chưa gắn tài khoản (chưa có chủ): PC quản trị đã ghép (LAN) nạp được như trước — vẫn phải đúng chữ ký.
// Hai đường cài: board tự tải từ server (/api/v1/mcu-firmware) khi vừa được duyệt, hoặc GatewayApp nạp qua LAN (POST /api/ota).
// Trước khi khởi động lại: enterSafeState() — TẮT mọi DO, lưu bộ đếm DI.
// Sau khi cài: bản mới ở trạng thái "chờ xác nhận" (bootloader ESP-IDF). Chạy ổn ≥ 60 s VÀ nối lại được cloud (nếu có cài cloud)
// trong 3 phút → xác nhận. Không thì tự quay về bản cũ; treo/crash trước đó → bootloader cũng tự quay về.
// Nhật ký /events.log (LittleFS, vòng ~24 KB): cập nhật, duyệt, quay lại bản cũ, ghép/đăng nhập PC, từ chối… Sự kiện bảo mật
// đồng thời gửi cảnh báo `gw/<id>/alert` k="sec.*" → server đẩy thông báo đỏ về điện thoại chủ trạm.
#include "gw.h"
#include "fwkey.h"
#include <LittleFS.h>
#include <Preferences.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include <esp_http_client.h>
#include <time.h>
#include <esp_crt_bundle.h>
#ifndef GW_SIM
#include <esp_ota_ops.h>
#endif

/// Arduino-ESP32: không tự xác nhận bản đang chạy lúc khởi động — otaLoop() xác nhận khi đã "khoẻ".
bool verifyRollbackLater() { return true; }

namespace {
const uint32_t kWindowSec = 15 * 60;
const uint32_t kHealthyMs = 60000, kGiveUpMs = 180000;
const char* kEv = "/events.log";
const char* kEvOld = "/events.old";

uint32_t s_until = 0;            // millis hết cửa sổ duyệt (0 = đóng)
String s_by;                     // người duyệt
bool s_pullTried = false;        // đã thử tải từ server trong cửa sổ này
bool s_pending = false;          // bản đang chạy chờ xác nhận
String s_from, s_byPrev;         // bản trước / người duyệt (đọc từ NVS sau khi khởi động)
uint32_t s_restartAt = 0;

// ---- ghi đang chạy
struct Job { bool on = false; size_t total = 0, got = 0; String ver, sha, sig, src; mbedtls_sha256_context ctx; } s_job;

std::vector<String> s_alerts;    // cảnh báo bảo mật chờ gửi lên cloud
SemaphoreHandle_t s_evMx = xSemaphoreCreateRecursiveMutex();
struct EvLock { EvLock() { xSemaphoreTakeRecursive(s_evMx, portMAX_DELAY); } ~EvLock() { xSemaphoreGiveRecursive(s_evMx); } };

bool windowOpen() { return s_until && (int32_t)(s_until - millis()) > 0; }
bool enrolled() { return g_cfg.cmdKey.length() > 0; }   // đã gắn tài khoản cloud → phải có chủ duyệt

String hexOf(const uint8_t* d, size_t n) { String s; char b[3]; for (size_t i = 0; i < n; i++) { snprintf(b, sizeof b, "%02x", d[i]); s += b; } return s; }

Preferences& nvs() { static Preferences p; static bool open = false; if (!open) { p.begin("ota", false); open = true; } return p; }
String nvsGet(const char* k) { return nvs().isKey(k) ? nvs().getString(k, "") : String(); }
}  // namespace

// ------------------------------------------------------------------ nhật ký sự kiện
void evLog(const char* type, const String& text, bool alertOwner) {
  logf("SỰ KIỆN [%s] %s", type, text.c_str());
  EvLock l;
  JsonDocument d;
  time_t t = time(nullptr);
  d["t"] = t > 1700000000 ? (long long)t : 0; d["up"] = millis() / 1000; d["k"] = type; d["x"] = text;
  if (File f = LittleFS.open(kEv, "a")) { serializeJson(d, f); f.print('\n'); size_t sz = f.size(); f.close();
    if (sz > 24 * 1024) { LittleFS.remove(kEvOld); LittleFS.rename(kEv, kEvOld); } }
  if (alertOwner && s_alerts.size() < 16) {
    JsonDocument a;
    a["schema"] = 1; a["k"] = String("sec.") + type; a["lv"] = "high"; a["v"] = 0; a["txt"] = text; a["ts"] = nowMs();
    String s; serializeJson(a, s); s_alerts.push_back(s);
  }
}

bool evNextAlert(String& out) { EvLock l; if (s_alerts.empty()) return false; out = s_alerts.front(); return true; }
void evAlertSent() { EvLock l; if (!s_alerts.empty()) s_alerts.erase(s_alerts.begin()); }

/// n sự kiện mới nhất (cũ → mới) dạng JSON array.
String evRecent(int n) {
  EvLock l;
  std::vector<String> lines;
  for (const char* p : {kEvOld, kEv}) {
    File f = LittleFS.open(p, "r"); if (!f) continue;
    while (f.available()) { String s = f.readStringUntil('\n'); s.trim(); if (s.length()) { lines.push_back(s); if ((int)lines.size() > n) lines.erase(lines.begin()); } }
    f.close();
  }
  String out = "[";
  for (size_t i = 0; i < lines.size(); i++) { if (i) out += ','; out += lines[i]; }
  return out + "]";
}

// ------------------------------------------------------------------ trạng thái an toàn
void enterSafeState(const char* why) {
  logf("Vào trạng thái an toàn trước khi khởi động lại: %s", why);
  { IoLock l; ioSetDo(0); }                       // TẮT mọi đầu ra (không chờ thời gian tối thiểu bật/tắt — an toàn trước)
  Preferences p; p.begin("gw", false);
  String c; for (int i = 0; i < 8; i++) { if (i) c += ','; c += String(ioDiCount(i)); }
  p.putString("dicnt", c);                        // khởi động lại có chủ đích: giữ bộ đếm xung DI (ioBegin đọc lại)
  p.end();
}

// ------------------------------------------------------------------ duyệt
void otaAllow(uint32_t ttlSec, const String& by) {
  ttlSec = ttlSec ? min<uint32_t>(ttlSec, kWindowSec) : kWindowSec;
  s_until = millis() + ttlSec * 1000UL; if (!s_until) s_until = 1;
  s_by = by.length() ? by : String("chủ trạm"); s_pullTried = false;
  evLog("ota_allow", "Chủ trạm (" + s_by + ") cho phép cập nhật trong " + String(ttlSec / 60) + " phút");
}

bool otaApproved(String& why) {
  if (!enrolled()) return true;
  if (windowOpen()) return true;
  why = "ota_not_approved";
  return false;
}

String otaStatusJson() {
  JsonDocument d;
  d["Version"] = FW_VERSION; d["Approved"] = windowOpen(); d["ApprovedBy"] = windowOpen() ? s_by : String("");
  d["RemainSec"] = windowOpen() ? (s_until - millis()) / 1000 : 0; d["PendingVerify"] = s_pending; d["Enrolled"] = enrolled();
  String s; serializeJson(d, s); return s;
}

// ------------------------------------------------------------------ ghi firmware (dùng chung LAN + server)
bool otaStart(size_t total, const String& ver, const String& shaHex, const String& sig, const String& src, String& err) {
  String why;
  if (!otaApproved(why)) {
    evLog("ota_denied", "Từ chối nạp firmware " + ver + " (" + src + "): chưa được chủ trạm duyệt", true);
    err = why; return false;
  }
  if (!ver.length() || !sig.length() || shaHex.length() != 64) { evLog("ota_denied", "Từ chối nạp firmware (" + src + "): thiếu chữ ký / phiên bản", true); err = "ota_unsigned"; return false; }
  // kiểm chữ ký TRƯỚC khi xoá phân vùng: sha256 khai báo phải được nhà phát triển ký; ghi xong còn đối chiếu sha256 thật
  String sh = shaHex; sh.toLowerCase();
  if (!verifySig(FW_SIGN_PUBKEY, "fw1|" + sh + "|" + ver, sig)) {
    evLog("ota_badsig", "Từ chối firmware " + ver + " (" + src + "): CHỮ KÝ KHÔNG HỢP LỆ", true);
    err = "ota_bad_signature"; return false;
  }
  if (s_job.on) { Update.abort(); mbedtls_sha256_free(&s_job.ctx); s_job.on = false; }
  if (!Update.begin(total, U_FLASH)) { err = String("ota_begin: ") + Update.errorString(); return false; }
  s_job.on = true; s_job.total = total; s_job.got = 0; s_job.ver = ver; s_job.sha = sh; s_job.sig = sig; s_job.src = src;
  mbedtls_sha256_init(&s_job.ctx); mbedtls_sha256_starts(&s_job.ctx, 0);
  logf("OTA: nhận firmware %s (%u byte) từ %s", ver.c_str(), (unsigned)total, src.c_str());
  return true;
}

bool otaWrite(const uint8_t* p, size_t n, String& err) {
  if (!s_job.on) { err = "ota_not_started"; return false; }
  mbedtls_sha256_update(&s_job.ctx, p, n);
  if (Update.write((uint8_t*)p, n) != n) { err = String("ota_write: ") + Update.errorString(); otaAbort(); return false; }
  s_job.got += n;
  return true;
}

void otaAbort() { if (s_job.on) { Update.abort(); mbedtls_sha256_free(&s_job.ctx); s_job.on = false; } }

bool otaFinish(String& err) {
  if (!s_job.on) { err = "ota_not_started"; return false; }
  uint8_t dig[32]; mbedtls_sha256_finish(&s_job.ctx, dig); mbedtls_sha256_free(&s_job.ctx);
  s_job.on = false;
  if (s_job.got != s_job.total) { Update.abort(); err = "ota_incomplete"; logf("OTA: đứt giữa chừng (%u/%u)", (unsigned)s_job.got, (unsigned)s_job.total); return false; }
  if (hexOf(dig, 32) != s_job.sha) { Update.abort(); err = "ota_bad_sha256"; evLog("ota_badsig", "Firmware " + s_job.ver + " (" + s_job.src + ") sai SHA-256 so với bản đã ký — huỷ", true); return false; }
  if (!Update.end(true)) { err = String("ota_end: ") + Update.errorString(); return false; }
  // ghi lại để bản mới biết mình vừa được cài (xác nhận / phát hiện quay lại bản cũ)
  nvs().putString("try", s_job.ver); nvs().putString("from", FW_VERSION); nvs().putString("by", enrolled() ? s_by : String("PC quản trị (LAN)"));
  evLog("ota_install", "Đã nạp firmware " + s_job.ver + " (từ " + String(FW_VERSION) + ", nguồn " + s_job.src + ") — khởi động lại");
  s_until = 0;                                     // cài xong: đóng cửa sổ duyệt
  s_restartAt = millis() + 1500; if (!s_restartAt) s_restartAt = 1;
  return true;
}

// ------------------------------------------------------------------ tải từ server
namespace {
struct Dl { String err; bool started = false; };
esp_err_t dlEvent(esp_http_client_event_t* e) {
  auto* d = (Dl*)e->user_data;
  if (e->event_id == HTTP_EVENT_ON_DATA && d->err.length() == 0) {
    wdtFeed(WD_LOOP);
    if (!otaWrite((const uint8_t*)e->data, e->data_len, d->err)) return ESP_FAIL;
  }
  return ESP_OK;
}

void pullFromServer() {
  String base = g_cfg.apiUrl.length() ? g_cfg.apiUrl : String("https://plc.dieukhientudong.net");
  while (base.endsWith("/")) base.remove(base.length() - 1);
  String resp;
  int st = httpsGet(base + "/api/v1/mcu-firmware", resp);
  JsonDocument m;
  if (st != 200 || deserializeJson(m, resp)) { evLog("ota_info", "Đã duyệt nhưng không lấy được thông tin bản mới từ server (HTTP " + String(st) + ")"); return; }
  String ver = m["version"] | "", sha = m["sha256"] | "", sig = m["sig"] | ""; size_t size = m["size"] | 0;
  if (ver == FW_VERSION) { evLog("ota_info", "Đã là bản mới nhất (" + ver + ")"); return; }
  String err;
  if (!otaStart(size, ver, sha, sig, "server", err)) return;
  Dl d;
  esp_http_client_config_t c = {};
  String url = base + "/api/v1/mcu-firmware/download";
  c.url = url.c_str(); c.method = HTTP_METHOD_GET; c.timeout_ms = 60000; c.event_handler = dlEvent; c.user_data = &d;
  c.crt_bundle_attach = esp_crt_bundle_attach;
#ifndef GW_SIM
  c.buffer_size = 4096;
#endif
  esp_http_client_handle_t h = esp_http_client_init(&c);
  esp_err_t e = h ? esp_http_client_perform(h) : ESP_FAIL;
  int code = h ? esp_http_client_get_status_code(h) : -1;
  if (h) esp_http_client_cleanup(h);
  if (e != ESP_OK || code != 200 || d.err.length()) { otaAbort(); evLog("ota_fail", "Tải firmware " + ver + " lỗi: " + (d.err.length() ? d.err : "HTTP " + String(code))); return; }
  if (!otaFinish(err)) evLog("ota_fail", "Cài firmware " + ver + " lỗi: " + err);
}
}  // namespace

// ------------------------------------------------------------------ khởi động / vòng lặp
void otaBegin() {
  String br = bootReason();
  if (br != "power_on" && br != "sw" && br != "sim") evLog("reboot", "Khởi động lại bất thường: " + br);
  if (safeMode()) evLog("safe_mode", "Khởi động lại bất thường " + String(safetyBootFails()) + " lần liền (" + br + ") — CHẾ ĐỘ AN TOÀN: DO giữ tắt 30 phút", true);
  String tried = nvsGet("try"), from = nvsGet("from"), by = nvsGet("by");
#ifndef GW_SIM
  esp_ota_img_states_t stt;
  const esp_partition_t* run = esp_ota_get_running_partition();
  s_pending = run && esp_ota_get_state_partition(run, &stt) == ESP_OK && stt == ESP_OTA_IMG_PENDING_VERIFY;
#else
  s_pending = tried.length() && tried == FW_VERSION;
#endif
  if (tried.length() && tried != FW_VERSION) {
    // vừa cài bản `tried` nhưng đang chạy bản khác → bootloader đã quay về bản cũ (bản mới treo/crash/không khoẻ)
    evLog("ota_rollback", "Firmware " + tried + " lỗi khi chạy — đã TỰ QUAY VỀ bản " + String(FW_VERSION), true);
    nvs().remove("try"); nvs().remove("from"); nvs().remove("by");
  } else if (s_pending) {
    s_from = from; s_byPrev = by;
    logf("Firmware %s mới cài (từ %s) — chờ chạy ổn 60 s + nối cloud để xác nhận, không thì quay về bản cũ", FW_VERSION, from.c_str());
  } else if (tried.length()) {
    nvs().remove("try"); nvs().remove("from"); nvs().remove("by");
  }
}

void otaLoop() {
  if (s_restartAt && (int32_t)(millis() - s_restartAt) >= 0) {
    s_restartAt = 0;
    enterSafeState("cập nhật firmware");
    delay(200);
    ESP.restart();
  }
  if (s_pending) {
    bool cloudExpected = g_cfg.cloudOn() && g_cfg.cloudHost.length() && g_cfg.mqttId.length();
    uint32_t up = millis();
    if (up >= kHealthyMs && (!cloudExpected || cloudLinkOk())) {
      s_pending = false;
#ifndef GW_SIM
      esp_ota_mark_app_valid_cancel_rollback();
#endif
      evLog("ota_ok", "Cập nhật thành công " + s_from + " → " + String(FW_VERSION) + " (duyệt: " + s_byPrev + ")");
      nvs().remove("try"); nvs().remove("from"); nvs().remove("by");
    } else if (up >= kGiveUpMs) {
      s_pending = false;
      evLog("ota_rollback", "Firmware " + String(FW_VERSION) + " không nối lại được cloud sau 3 phút — quay về bản " + s_from, true);
      enterSafeState("quay về firmware cũ");
      delay(300);
#ifndef GW_SIM
      esp_ota_mark_app_invalid_rollback_and_reboot();   // không quay lại được (chưa có bản cũ) thì hàm trả về: chạy tiếp bản này
      logf("Không có bản cũ để quay về — giữ bản đang chạy");
#endif
    }
  }
  if (windowOpen() && !s_pullTried && enrolled() && cloudLinkOk()) { s_pullTried = true; pullFromServer(); }
  if (s_until && !windowOpen()) { s_until = 0; logf("Hết thời gian cho phép cập nhật"); }
}
