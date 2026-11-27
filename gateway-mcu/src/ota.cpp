// CẬP NHẬT FIRMWARE CÓ DUYỆT + TỰ QUAY LẠI BẢN CŨ + NHẬT KÝ SỰ KIỆN (trạm không người trông).
//
// Chìa khoá 2 lớp:
//   1. CHỮ KÝ của nhà phát triển: chỉ cài bản có chữ ký `fw1|<sha256>|<phiên bản>` khớp khoá công khai gắn cứng (fwkey.h).
//   2. CHỦ TRẠM DUYỆT: board đã gắn tài khoản (có khoá ký của server) chỉ nhận cập nhật trong 15 phút sau khi chủ bấm
//      "Cho phép cập nhật" trên webapp (server gửi {sys:"ota_allow"} có chữ ký). Hết cửa sổ / cài xong → đóng lại.
//      Board chưa gắn tài khoản (chưa có chủ): PC quản trị đã ghép (LAN) nạp được như trước — vẫn phải đúng chữ ký.
// Hai đường cài: board tự tải từ server (/api/v1/mcu-firmware) khi vừa được duyệt, hoặc GatewayApp nạp qua LAN (POST /api/ota).
// Trước khi khởi động lại: enterSafeState() — TẮT mọi DO, lưu bộ đếm DI.
// Sau khi cài: bản mới ở trạng thái "chờ xác nhận" (bootloader ESP-IDF, CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE). Bản mới chỉ được
// XÁC NHẬN khi qua đủ KIỂM TRA SỨC KHOẺ trong 5 phút (kGiveUpMs), không thì TỰ QUAY VỀ bản cũ (lý do lưu NVS "why", ghi nhật ký):
//   up      chạy liên tục ≥ 60 s (treo / crash / watchdog trước đó → bootloader tự quay về)
//   net     MẠNG như trước khi cập nhật: trước đó cloud đang nối → phải nối lại cloud; trước đó chỉ có LAN → phải có IP.
//           Trước đó đã mất mạng sẵn → không đòi (không quay về oan vì sự cố mạng có sẵn).
//   ota     còn CẬP NHẬT ĐƯỢC: có phân vùng OTA kế tiếp, cổng HTTPS LAN đã mở (GatewayApp nạp qua LAN), và — khi trước đó cloud
//           đang nối — tải được thông tin firmware từ server qua HTTPS (đường board tự tải bản mới). Bản mới làm hỏng đường cập nhật
//           sẽ bị bỏ, vì nếu xác nhận nó thì không còn cách nào nạp bản sửa từ xa.
//   io      I/O trên board trả lời (TCA9554 — DO) và vòng đọc thiết bị chạy (engineSeq tăng).
// Bản đã quay về đọc NVS "why" để báo lý do (cảnh báo về điện thoại chủ trạm).
// QUAY VỀ LÀM TRONG ỨNG DỤNG, không phụ thuộc bootloader (bootloader dựng sẵn của Arduino không chắc bật rollback — thử trên board
// thật: ảnh mới ở trạng thái NEW chứ không phải PENDING_VERIFY): bản mới nhận ra mình qua NVS "try"; đếm số lần khởi động khi chưa
// xác nhận ("boots") — lần thứ kMaxBoots mà vẫn chưa xác nhận (crash / watchdog / mất điện liên tục) → trỏ boot về phân vùng cũ.
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
#include <esp_random.h>
#ifndef GW_SIM
#include <esp_ota_ops.h>
#include <esp_heap_caps.h>
#endif

/// Arduino-ESP32: không tự xác nhận bản đang chạy lúc khởi động — otaLoop() xác nhận khi đã "khoẻ".
bool verifyRollbackLater() { return true; }

namespace {
const uint32_t kWindowSec = 15 * 60;
const uint32_t kHealthyMs = 60000, kGiveUpMs = 300000;
const int kMaxBoots = 3;          // bản mới khởi động lại ngần này lần mà chưa xác nhận → quay về
const char* kEv = "/events.log";
const char* kEvOld = "/events.old";

uint32_t s_until = 0;            // millis hết cửa sổ duyệt (0 = đóng)
String s_by;                     // người duyệt
bool s_pullTried = false;        // đã thử tải từ server trong cửa sổ này (thành công / đã là bản mới nhất / board từ chối)
uint32_t s_pullAt = 0;           // lần thử gần nhất — lỗi mạng thì thử lại mỗi phút trong cửa sổ cho phép
bool s_pending = false;          // bản đang chạy chờ xác nhận
String s_from, s_byPrev;         // bản trước / người duyệt (đọc từ NVS sau khi khởi động)
// kiểm tra sức khoẻ của bản đang chờ xác nhận
int s_netBefore = -1;            // trước khi cập nhật: 2 = cloud đang nối, 1 = chỉ có IP (LAN), 0 = mất mạng, -1 = không rõ (bản cũ không ghi)
bool s_chkNet = false, s_chkOta = false, s_chkIo = false, s_srvOk = false;
uint32_t s_seq0 = 0, s_srvTry = 0;
String s_chkWhy;
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
  s_by = by.length() ? by : String("chủ trạm"); s_pullTried = false; s_pullAt = 0;
  evLog("ota_allow", "Chủ trạm (" + s_by + ") cho phép cập nhật trong " + String(ttlSec / 60) + " phút");
}

// ------------------------------------------------------------------ duyệt QUA GATEWAY PC (board là slave, không tự lên cloud)
// Board giữ lease của gateway PC thì tạm dừng MQTTS: không nhận được ota_allow từ server. Gateway PC (đã ghép, xác thực HTTPS) chuyển tiếp:
//   1. GET /api/ota/nonce → mã dùng một lần (sống 2 phút) — thay cho kiểm giờ (board slave có thể không có internet/NTP)
//   2. gateway PC hỏi server: chủ trạm đã cho phép chưa → server KÝ {sys:"ota_allow", ttl, by, nonce} bằng khoá lệnh (miền cmd1, gắn mqttId board)
//   3. POST /api/ota/allow {Packet} → board kiểm chữ ký server + nonce → mở cửa sổ như nhận qua MQTT.
// Gateway PC không tự tạo được lệnh cho phép (không có khoá server); firmware vẫn phải có chữ ký nhà phát triển.
namespace {
String s_nonce; uint32_t s_nonceAt = 0;
const uint32_t kNonceMs = 120000;
}

String otaNonce() {
  uint8_t r[12]; esp_fill_random(r, sizeof r);
  s_nonce = hexOf(r, sizeof r); s_nonceAt = millis();
  return s_nonce;
}

bool otaAllowRelay(const String& packet, const String& via, String& err) {
  if (!enrolled()) { err = "not_enrolled"; return false; }   // board chưa gắn cloud: không cần duyệt (otaApproved cho qua)
  if (!s_nonce.length() || millis() - s_nonceAt > kNonceMs) { s_nonce = ""; err = "nonce_expired"; return false; }
  String plain;
  if (!verifyCmd(packet, g_cfg.mqttId, g_cfg.cmdKey, plain)) {
    evLog("ota_denied", "Lệnh cho phép cập nhật chuyển qua " + via + " SAI CHỮ KÝ server — bị từ chối", true);
    err = "bad_sig"; return false;
  }
  JsonDocument d;
  if (deserializeJson(d, plain)) { err = "bad_json"; return false; }
  if (String(d["sys"] | "") != "ota_allow" || String(d["nonce"] | "") != s_nonce) { err = "nonce_mismatch"; return false; }
  s_nonce = "";   // dùng một lần: gói đã ký không phát lại được
  otaAllow(d["ttl"] | 900, String(d["by"] | "") + " · qua " + via);
  return true;
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
  d["CloudId"] = g_cfg.mqttId; d["Channel"] = FW_CHANNEL;   // gateway PC hỏi server đúng board + đúng kênh phát hành (dev / chính thức)
  d["Lease"] = leaseActive();
#ifndef GW_SIM
  if (const esp_partition_t* run = esp_ota_get_running_partition()) {
    esp_ota_img_states_t stt; d["Partition"] = run->label;
    if (esp_ota_get_state_partition(run, &stt) == ESP_OK) d["ImgState"] = (int)stt;   // 0 NEW, 1 PENDING_VERIFY, 2 VALID, 3 INVALID, 4 ABORTED, -1 UNDEFINED
  }
#endif
  if (s_pending) {
    JsonObject h = d["Health"].to<JsonObject>();
    h["UpSec"] = millis() / 1000; h["GiveUpSec"] = kGiveUpMs / 1000; h["NetBefore"] = s_netBefore;
    h["Net"] = s_chkNet; h["Ota"] = s_chkOta; h["Io"] = s_chkIo; h["Why"] = s_chkWhy;
  }
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
  bool sigOk = verifySig(FW_SIGN_PUBKEY, "fw1|" + sh + "|" + ver, sig);
#ifdef FW_DEV_PUBKEY
  if (!sigOk) sigOk = verifySig(FW_DEV_PUBKEY, "fw1|" + sh + "|" + ver, sig);   // bản build dev: tin thêm khoá dev
#endif
  if (!sigOk) {
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
  nvs().putString("net", cloudLinkOk() ? "2" : netUp() ? "1" : "0");   // bản mới phải lấy lại đúng mức mạng này
  nvs().remove("why");
  evLog("ota_install", "Đã nạp firmware " + s_job.ver + " (từ " + String(FW_VERSION) + ", nguồn " + s_job.src + ") — khởi động lại");
  s_until = 0;                                     // cài xong: đóng cửa sổ duyệt
  s_restartAt = millis() + 1500; if (!s_restartAt) s_restartAt = 1;
  return true;
}

// ------------------------------------------------------------------ tải từ server
namespace {
/// Kênh phát hành: "" = chính thức (releases/mcu), "dev" = bản thử (releases/mcu-dev) — chỉ bản build dev.
String chq() { return strlen(FW_CHANNEL) ? String("?ch=") + FW_CHANNEL : String(""); }
struct Dl { String err; bool started = false; };
esp_err_t dlEvent(esp_http_client_event_t* e) {
  auto* d = (Dl*)e->user_data;
  if (e->event_id == HTTP_EVENT_ON_DATA && d->err.length() == 0) {
    wdtFeed(WD_LOOP);
    if (!otaWrite((const uint8_t*)e->data, e->data_len, d->err)) return ESP_FAIL;
  }
  return ESP_OK;
}

String heapText() {
#ifndef GW_SIM
  return ", RAM trống " + String(ESP.getFreeHeap() / 1024) + " KB, khối lớn nhất " + String(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) / 1024) + " KB";
#else
  return "";
#endif
}

void pullFromServer() {
  String base = g_cfg.apiUrl.length() ? g_cfg.apiUrl : String("https://plc.dieukhientudong.net");
  while (base.endsWith("/")) base.remove(base.length() - 1);
  String resp;
  int st = httpsGet(base + "/api/v1/mcu-firmware" + chq(), resp);
  JsonDocument m;
  if (st != 200 || deserializeJson(m, resp)) {
    // lỗi mạng: để otaLoop thử lại sau 1 phút (s_pullTried = false). Ghi rõ lỗi + RAM để chẩn đoán không cần cổng USB.
    s_pullTried = false;
    evLog("ota_info", "Đã duyệt nhưng chưa lấy được thông tin bản mới từ server (HTTP " + String(st) + (httpsLastError().length() ? " " + httpsLastError() : String("")) +
          heapText() + ") — thử lại sau 1 phút");
    return;
  }
  String ver = m["version"] | "", sha = m["sha256"] | "", sig = m["sig"] | ""; size_t size = m["size"] | 0;
  if (ver == FW_VERSION) { evLog("ota_info", "Đã là bản mới nhất (" + ver + ")"); return; }
  String err;
  if (!otaStart(size, ver, sha, sig, "server", err)) return;
  Dl d;
  esp_http_client_config_t c = {};
  String url = base + "/api/v1/mcu-firmware/download" + chq();
  c.url = url.c_str(); c.method = HTTP_METHOD_GET; c.timeout_ms = 60000; c.event_handler = dlEvent; c.user_data = &d;
  c.crt_bundle_attach = esp_crt_bundle_attach;
#ifndef GW_SIM
  c.buffer_size = 4096;
#endif
  esp_http_client_handle_t h = esp_http_client_init(&c);
  esp_err_t e = h ? esp_http_client_perform(h) : ESP_FAIL;
  int code = h ? esp_http_client_get_status_code(h) : -1;
  if (h) esp_http_client_cleanup(h);
  if (e != ESP_OK || code != 200 || d.err.length()) {
    otaAbort(); s_pullTried = false;   // lỗi mạng giữa chừng: thử lại sau 1 phút (còn trong cửa sổ cho phép)
    evLog("ota_fail", "Tải firmware " + ver + " lỗi: " + (d.err.length() ? d.err : "HTTP " + String(code) + (e != ESP_OK ? String(" ") + esp_err_to_name(e) : String(""))) + heapText() + " — thử lại sau 1 phút");
    return;
  }
  if (!otaFinish(err)) evLog("ota_fail", "Cài firmware " + ver + " lỗi: " + err);
}
}  // namespace

// ------------------------------------------------------------------ khởi động / vòng lặp
namespace {
/// Quay về bản cũ NGAY: tắt đầu ra, trỏ boot về phân vùng OTA còn lại (bản trước) rồi khởi động lại. Trả về = không có bản cũ hợp lệ.
void rollbackNow() {
  enterSafeState("quay về firmware cũ");
  delay(300);
#ifndef GW_SIM
  esp_ota_mark_app_invalid_rollback_and_reboot();   // có bootloader hỗ trợ: nó làm hết (không trả về)
  // bootloader không hỗ trợ rollback: tự trỏ boot về phân vùng kia nếu ở đó có ảnh hợp lệ
  const esp_partition_t* run = esp_ota_get_running_partition();
  const esp_partition_t* prev = esp_ota_get_next_update_partition(run);
  esp_app_desc_t desc;
  if (prev && prev != run && esp_ota_get_partition_description(prev, &desc) == ESP_OK && esp_ota_set_boot_partition(prev) == ESP_OK) {
    logf("Trỏ boot về %s (%s) — khởi động lại", prev->label, desc.version);
    delay(200);
    esp_restart();
  }
#endif
}
}  // namespace

void otaBegin() {
  String br = bootReason();
  if (br != "power_on" && br != "sw" && br != "sim") evLog("reboot", "Khởi động lại bất thường: " + br);
  if (safeMode()) evLog("safe_mode", "Khởi động lại bất thường " + String(safetyBootFails()) + " lần liền (" + br + ") — CHẾ ĐỘ AN TOÀN: DO giữ tắt 30 phút", true);
  String tried = nvsGet("try"), from = nvsGet("from"), by = nvsGet("by"), why = nvsGet("why"), net = nvsGet("net");
  // bản mới = vừa được bản cũ cài (NVS "try" = chính phiên bản này) và chưa xác nhận. Không dựa riêng vào trạng thái ảnh của bootloader.
  s_pending = tried.length() && tried == FW_VERSION;
#ifndef GW_SIM
  esp_ota_img_states_t stt;
  const esp_partition_t* run = esp_ota_get_running_partition();
  if (run && esp_ota_get_state_partition(run, &stt) == ESP_OK && stt == ESP_OTA_IMG_PENDING_VERIFY) s_pending = true;
#endif
  if (s_pending) {
    int boots = nvsGet("boots").toInt() + 1;
    nvs().putString("boots", String(boots));
    if (boots >= kMaxBoots) {   // khởi động lại liên tục mà chưa qua kiểm tra: quay về ngay, không chờ 5 phút
      nvs().putString("why", "khởi động lại " + String(boots) + " lần liền chưa chạy ổn (" + bootReason() + ")");
      logf("Firmware %s khởi động lại %d lần chưa xác nhận — quay về bản cũ", FW_VERSION, boots);
      rollbackNow();
    }
  }
  if (tried.length() && tried != FW_VERSION) {
    // vừa cài bản `tried` nhưng đang chạy bản khác → bootloader đã quay về bản cũ (bản mới treo/crash/không khoẻ)
    evLog("ota_rollback", "Firmware " + tried + " lỗi khi chạy (" + (why.length() ? why : String("treo / khởi động lại")) + ") — đã TỰ QUAY VỀ bản " + String(FW_VERSION), true);
    nvs().remove("try"); nvs().remove("from"); nvs().remove("by"); nvs().remove("why"); nvs().remove("net"); nvs().remove("boots");
  } else if (s_pending) {
    s_from = from; s_byPrev = by; s_netBefore = net.length() ? net.toInt() : -1; s_seq0 = engineSeq();
    logf("Firmware %s mới cài (từ %s) — kiểm tra sức khoẻ (mạng như trước: %d, còn cập nhật được, I/O) trong %lu s, không đạt thì quay về bản cũ",
         FW_VERSION, from.c_str(), s_netBefore, (unsigned long)(kGiveUpMs / 1000));
  } else if (tried.length()) {
    nvs().remove("try"); nvs().remove("from"); nvs().remove("by"); nvs().remove("why"); nvs().remove("net"); nvs().remove("boots");
  }
}

namespace {
/// Một lượt kiểm tra sức khoẻ của bản đang chờ xác nhận. Cập nhật s_chk*; s_chkWhy = điều đầu tiên chưa đạt.
void healthCheck() {
  uint32_t up = millis();
  bool cloudExpected = g_cfg.cloudOn() && g_cfg.cloudHost.length() && g_cfg.mqttId.length();
  // mạng: lấy lại đúng mức trước khi cập nhật (không rõ — bản cũ không ghi: như trước đây, đòi cloud nếu có cài)
  int need = s_netBefore >= 0 ? s_netBefore : (cloudExpected ? 2 : 0);
  if (need == 2 && !cloudExpected) need = 1;   // cấu hình cloud vừa bị tắt: chỉ cần IP
  s_chkNet = need == 2 ? cloudLinkOk() : need == 1 ? netUp() : true;
  // còn cập nhật được
  bool part = true;
#ifndef GW_SIM
  part = esp_ota_get_next_update_partition(nullptr) != nullptr;
#endif
  if (need == 2 && !s_srvOk && cloudLinkOk() && (!s_srvTry || up - s_srvTry >= 30000)) {
    s_srvTry = up;
    String base = g_cfg.apiUrl.length() ? g_cfg.apiUrl : String("https://plc.dieukhientudong.net");
    while (base.endsWith("/")) base.remove(base.length() - 1);
    String resp; JsonDocument m;
    int st = httpsGet(base + "/api/v1/mcu-firmware" + chq(), resp);
    s_srvOk = (st == 200 || st == 404) && (st == 404 || (!deserializeJson(m, resp) && m["version"].is<const char*>()));   // 404 = server chưa phát bản nào: vẫn là HTTPS tới server được
    if (!s_srvOk) logf("Kiểm tra sau cập nhật: chưa tải được thông tin firmware từ server (HTTP %d)", st);
  }
  s_chkOta = part && (apiStarted() || !netUp()) && (need != 2 || s_srvOk);
  // I/O + vòng đọc
  s_chkIo = ioDoOk() && (!g_running || g_locked || engineSeq() - s_seq0 >= 3);
  s_chkWhy = !s_chkNet ? (need == 2 ? "không nối lại được cloud" : "không có mạng (IP)")
           : !s_chkOta ? (!part ? "không có phân vùng OTA để cập nhật tiếp" : !(apiStarted() || !netUp()) ? "cổng cài đặt LAN (HTTPS) không mở" : "không tải được thông tin firmware từ server (HTTPS)")
           : !s_chkIo ? (!ioDoOk() ? "I/O trên board (DO) không trả lời" : "vòng đọc thiết bị không chạy")
           : "";
}
}  // namespace

void otaLoop() {
  if (s_restartAt && (int32_t)(millis() - s_restartAt) >= 0) {
    s_restartAt = 0;
    enterSafeState("cập nhật firmware");
    delay(200);
    ESP.restart();
  }
  static uint32_t s_lastChk = 0;
  if (s_pending && (!s_lastChk || millis() - s_lastChk >= 1000)) {
    s_lastChk = millis();
    uint32_t up = millis();
    healthCheck();
    if (up >= kHealthyMs && s_chkWhy.length() == 0) {
      s_pending = false;
#ifndef GW_SIM
      esp_ota_mark_app_valid_cancel_rollback();
#endif
      evLog("ota_ok", "Cập nhật thành công " + s_from + " → " + String(FW_VERSION) + " (duyệt: " + s_byPrev + "; mạng, đường cập nhật, I/O đều đạt)");
      nvs().remove("try"); nvs().remove("from"); nvs().remove("by"); nvs().remove("why"); nvs().remove("net"); nvs().remove("boots");
    } else if (up >= kGiveUpMs) {
      s_pending = false;
      nvs().putString("why", s_chkWhy);   // bản cũ đọc lại để báo lý do
      evLog("ota_rollback", "Firmware " + String(FW_VERSION) + " không đạt kiểm tra sau " + String(kGiveUpMs / 60000) + " phút: " + s_chkWhy + " — quay về bản " + s_from, true);
      rollbackNow();
      logf("Không có bản cũ để quay về — giữ bản đang chạy");
    }
  }
  if (windowOpen() && !s_pullTried && enrolled() && cloudLinkOk() && (!s_pullAt || millis() - s_pullAt >= 60000)) { s_pullTried = true; s_pullAt = millis(); if (!s_pullAt) s_pullAt = 1; pullFromServer(); }
  if (s_until && !windowOpen()) { s_until = 0; logf("Hết thời gian cho phép cập nhật"); }
}
