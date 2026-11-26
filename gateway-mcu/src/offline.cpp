// LOGIC KHI MẤT MẠNG theo từng DO của board (chính sách lưu ở /offline.json, sửa bằng GatewayApp qua LAN — sau này GatewayAdmin
// từ xa qua cùng API). Người dùng phổ thông không sửa: không có giao diện trên webapp.
//
// "Mất mạng" = mất NGƯỜI ĐIỀU KHIỂN (safety.cpp): cloud đã cài mà MQTT không nối, hoặc PC từng giữ lease mà mất lease.
// Mất liên tục quá DelaySec của chân → chân đó chạy theo chính sách:
//   hold      giữ nguyên (mặc định, chân không có trong file)
//   off / on  về giá trị mặc định
//   schedule  bật trong khung giờ From→To mỗi ngày (giờ địa phương = UTC + TzMin); KHÔNG có giờ tin được → TẮT
//   follow    theo DI (Invert = ngược)
//   threshold theo giá trị field (child.field): On < Off → bật khi ≤ On, tắt khi ≥ Off (bơm cấp nước);
//             On > Off → bật khi ≥ On, tắt khi ≤ Off (quạt theo nhiệt). Giữa hai ngưỡng: giữ (có trễ).
//             Mất số liệu (chưa đọc được / cũ hơn MaxAgeSec) → TẮT
//   cycle     bật OnSec, nghỉ OffSec, lặp (bắt đầu bằng BẬT)
// Có mạng lại: logic dừng, DO GIỮ trạng thái đang có (người vận hành quyết định tiếp), không tự nhảy về trạng thái cũ.
// Người tại chỗ đổi DO (API LAN) trong lúc chạy offline → chân đó chuyển "tay", logic nhường tới khi có mạng lại.
// Các lớp an toàn vẫn chặn sau cùng: thời gian tối thiểu giữa 2 lần bật/tắt (đợi đủ rồi mới đổi), chế độ an toàn (chỉ cho TẮT).
// Field::lossOffSec (PackMap.LossOffSec, cách cũ) = "off" với DelaySec đó, chỉ khi chân KHÔNG có trong /offline.json.
// THỬ MẤT MẠNG (offlineTest): coi như mất mạng ngay (bỏ qua DelaySec) trong N giây — kỹ thuật viên/admin xem logic chạy đúng.
#include "gw.h"
#include <LittleFS.h>
#include <time.h>

namespace {
enum class OMode : uint8_t { Hold, Off, On, Schedule, Follow, Threshold, Cycle };
const char* const kModes[] = {"hold", "off", "on", "schedule", "follow", "threshold", "cycle"};
const char* kPath = "/offline.json";
const char* kTmp = "/offline.tmp";

struct Pol {
  bool set = false;                  // có trong /offline.json (kể cả "hold" đặt rõ)
  OMode mode = OMode::Hold;
  uint32_t delaySec = 60;
  int fromMin = 0, toMin = 0;        // schedule: phút trong ngày (giờ địa phương)
  int di = 1; bool invert = false;   // follow: DI 1..8
  String field; double on = 0, off = 0; uint32_t maxAgeSec = 30;   // threshold
  uint32_t onSec = 600, offSec = 600;                                // cycle
};
struct Rt { bool active = false, manual = false, thr = false, want = false; uint32_t since = 0; String note; };

Pol s_pol[8];
Rt s_rt[8];
int s_tzMin = 420;                   // Việt Nam UTC+7
uint32_t s_rev = 0;
uint32_t s_legacy[8] = {0};          // Field::lossOffSec theo chân
uint32_t s_testUntil = 0;
bool s_wasDown = false;
SemaphoreHandle_t s_mx = xSemaphoreCreateRecursiveMutex();   // chính sách + trạng thái chạy (API LAN ↔ task io)
struct OLock { OLock() { xSemaphoreTakeRecursive(s_mx, portMAX_DELAY); } ~OLock() { xSemaphoreGiveRecursive(s_mx); } };

int modeOf(const String& s) { for (int i = 0; i < 7; i++) if (s == kModes[i]) return i; return -1; }

/// "HH:MM" → phút trong ngày; -1 = sai.
int hhmm(const String& s) {
  int h, m; char c;
  if (s.length() < 3 || s.length() > 5 || sscanf(s.c_str(), "%d%c%d", &h, &c, &m) != 3 || c != ':' || h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}
String fmtHm(int m) { char b[6]; snprintf(b, sizeof b, "%02d:%02d", m / 60, m % 60); return b; }

/// Chính sách thật sự áp dụng cho chân ch (file > LossOffSec cũ > giữ nguyên).
Pol effective(int ch) {
  if (s_pol[ch].set) return s_pol[ch];
  Pol p;
  if (s_legacy[ch]) { p.mode = OMode::Off; p.delaySec = s_legacy[ch]; }
  return p;
}

/// Đọc một chính sách từ JSON (API / file). "" = hợp lệ, còn lại câu báo lỗi tiếng Việt (hiện trên GatewayApp).
String parse(JsonObjectConst o, Pol& p, int& ch) {
  ch = o["Ch"] | 0;
  String w = "DO" + String(ch);
  if (ch < 1 || ch > 8) return "Chân DO phải từ 1 đến 8.";
  int m = modeOf(o["Mode"] | "hold");
  if (m < 0) return w + ": kiểu không hợp lệ.";
  p = Pol(); p.set = true; p.mode = (OMode)m;
  long d = o["DelaySec"] | 60L;
  if (d < 0 || d > 86400) return w + ": thời gian chờ phải từ 0 đến 86400 giây.";
  p.delaySec = (uint32_t)d;
  switch (p.mode) {
    case OMode::Schedule:
      p.fromMin = hhmm(o["From"] | ""); p.toMin = hhmm(o["To"] | "");
      if (p.fromMin < 0 || p.toMin < 0) return w + ": giờ bật/tắt phải dạng HH:MM.";
      if (p.fromMin == p.toMin) return w + ": giờ bật và giờ tắt phải khác nhau.";
      break;
    case OMode::Follow:
      p.di = o["Di"] | 0; p.invert = o["Invert"] | false;
      if (p.di < 1 || p.di > 8) return w + ": chân DI phải từ 1 đến 8.";
      break;
    case OMode::Threshold: {
      p.field = o["Field"] | ""; p.field.trim();
      if (!o["On"].is<double>() || !o["Off"].is<double>()) return w + ": cần ngưỡng bật và ngưỡng tắt.";
      p.on = o["On"]; p.off = o["Off"];
      if (!p.field.length()) return w + ": chưa chọn giá trị theo dõi.";
      if (p.on == p.off) return w + ": ngưỡng bật và ngưỡng tắt phải khác nhau (để có khoảng trễ).";
      long a = o["MaxAgeSec"] | 30L;
      if (a < 1 || a > 86400) return w + ": thời gian mất số liệu phải từ 1 đến 86400 giây.";
      p.maxAgeSec = (uint32_t)a;
      bool found = false;
      { Lock l; for (auto& f : g_cfg.pack) if (f.child + "." + f.field == p.field && f.access != Access::Write) { found = true; break; } }
      if (!found) return w + ": giá trị \"" + p.field + "\" không có trong cấu hình (hoặc là field chỉ ghi).";
      break;
    }
    case OMode::Cycle: {
      long a = o["OnSec"] | 0L, b = o["OffSec"] | 0L;
      if (a < 1 || a > 86400 || b < 1 || b > 86400) return w + ": thời gian bật / nghỉ phải từ 1 giây đến 24 giờ.";
      p.onSec = (uint32_t)a; p.offSec = (uint32_t)b;
      break;
    }
    default: break;
  }
  return "";
}

void toJson(int ch, const Pol& p, JsonObject o) {
  o["Ch"] = ch + 1; o["Mode"] = kModes[(int)p.mode]; o["DelaySec"] = p.delaySec;
  switch (p.mode) {
    case OMode::Schedule: o["From"] = fmtHm(p.fromMin); o["To"] = fmtHm(p.toMin); break;
    case OMode::Follow: o["Di"] = p.di; o["Invert"] = p.invert; break;
    case OMode::Threshold: o["Field"] = p.field; o["On"] = p.on; o["Off"] = p.off; o["MaxAgeSec"] = p.maxAgeSec; break;
    case OMode::Cycle: o["OnSec"] = p.onSec; o["OffSec"] = p.offSec; break;
    default: break;
  }
}

/// Mô tả ngắn tiếng Việt (log + GatewayApp).
String describe(const Pol& p) {
  switch (p.mode) {
    case OMode::Hold: return "giữ nguyên";
    case OMode::Off: return "tắt";
    case OMode::On: return "bật";
    case OMode::Schedule: return "bật " + fmtHm(p.fromMin) + " → tắt " + fmtHm(p.toMin);
    case OMode::Follow: return String(p.invert ? "ngược " : "theo ") + "DI" + String(p.di);
    case OMode::Threshold: return p.field + (p.on < p.off ? " ≤ " : " ≥ ") + String(p.on, 2) + " bật, " + (p.on < p.off ? "≥ " : "≤ ") + String(p.off, 2) + " tắt";
    case OMode::Cycle: return "bật " + String(p.onSec) + " s / nghỉ " + String(p.offSec) + " s";
  }
  return "";
}

bool saveFile(const JsonDocument& d) {
  File f = LittleFS.open(kTmp, "w");
  if (!f) return false;
  size_t n = serializeJson(d, f); f.close();
  if (!n) { LittleFS.remove(kTmp); return false; }
  return LittleFS.rename(kTmp, kPath);   // ghi đè nguyên tử, như config.json
}

/// Áp tài liệu {Rev,TzMin,Do:[…]} vào bộ nhớ. "" = ok.
String applyDoc(JsonObjectConst d, bool strict) {
  Pol np[8]; int tz = d["TzMin"] | 420;
  if (tz < -720 || tz > 840) return "Múi giờ không hợp lệ.";
  for (JsonObjectConst o : d["Do"].as<JsonArrayConst>()) {
    Pol p; int ch; String e = parse(o, p, ch);
    if (e.length()) { if (strict) return e; logf("offline.json: bỏ %s", e.c_str()); continue; }
    if (np[ch - 1].set && strict) return "DO" + String(ch) + " bị khai hai lần.";
    np[ch - 1] = p;
  }
  OLock l;
  for (int i = 0; i < 8; i++) { s_pol[i] = np[i]; s_rt[i] = Rt(); }
  s_tzMin = tz;
  s_rev = d["Rev"] | 0;
  return "";
}

bool inWindow(int m, int from, int to) { return from < to ? (m >= from && m < to) : (m >= from || m < to); }
}  // namespace

void offlineBegin() {
  File f = LittleFS.open(kPath, "r");
  if (!f) { LittleFS.remove(kTmp); return; }   // chưa cài: mọi chân giữ nguyên
  JsonDocument d; bool ok = !deserializeJson(d, f); f.close();
  if (!ok) { logf("offline.json hỏng — mọi DO giữ nguyên khi mất mạng"); return; }
  applyDoc(d.as<JsonObjectConst>(), false);
  int n = 0; for (auto& p : s_pol) if (p.set && p.mode != OMode::Hold) n++;
  logf("Logic khi mất mạng: %d chân DO có chính sách (rev %lu)", n, (unsigned long)s_rev);
}

void offlineLegacyLoss(const uint32_t* sec8) { OLock l; for (int i = 0; i < 8; i++) s_legacy[i] = sec8[i]; }

void offlineGet(JsonDocument& out) {
  OLock l;
  out["Rev"] = s_rev; out["TzMin"] = s_tzMin;
  JsonArray a = out["Do"].to<JsonArray>();
  for (int i = 0; i < 8; i++) if (s_pol[i].set) toJson(i, s_pol[i], a.add<JsonObject>());
  JsonArray lg = out["Legacy"].to<JsonArray>();   // LossOffSec cũ còn hiệu lực (chân chưa có trong file)
  for (int i = 0; i < 8; i++) if (!s_pol[i].set && s_legacy[i]) { JsonObject o = lg.add<JsonObject>(); o["Ch"] = i + 1; o["DelaySec"] = s_legacy[i]; }
  uint32_t downMs = 0; bool down = safetyLinkDown(downMs);
  bool test = s_testUntil && (int32_t)(s_testUntil - millis()) > 0;
  JsonObject st = out["Status"].to<JsonObject>();
  st["Down"] = down || test; st["DownSec"] = downMs / 1000; st["Expected"] = safetyLinkExpected();
  st["TestSec"] = test ? (s_testUntil - millis()) / 1000 : 0; st["TimeOk"] = timeTrusted();
  uint8_t d = ioDo();
  JsonArray ca = st["Ch"].to<JsonArray>();
  for (int i = 0; i < 8; i++) {
    Pol p = effective(i);
    JsonObject o = ca.add<JsonObject>();
    o["Ch"] = i + 1; o["Mode"] = kModes[(int)p.mode]; o["Active"] = s_rt[i].active; o["Manual"] = s_rt[i].manual;
    o["Out"] = (d >> i) & 1; o["Text"] = describe(p); o["Note"] = s_rt[i].note;
  }
}

String offlinePut(JsonObjectConst in, uint32_t& rev) {
  if (!in["Rev"].isNull() && (uint32_t)(in["Rev"] | 0) != s_rev) return "rev_conflict";   // người khác vừa sửa: tải lại rồi sửa tiếp
  JsonDocument d; d["Rev"] = s_rev + 1; d["TzMin"] = in["TzMin"] | 420;
  JsonArray a = d["Do"].to<JsonArray>();
  for (JsonObjectConst o : in["Do"].as<JsonArrayConst>()) a.add(o);
  // kiểm hết trước khi ghi (parse đủ mọi lỗi), rồi mới lưu và áp
  { Pol p; int ch; bool seen[8] = {false};
    for (JsonObjectConst o : d["Do"].as<JsonArrayConst>()) {
      String e = parse(o, p, ch); if (e.length()) return e;
      if (seen[ch - 1]) return "DO" + String(ch) + " bị khai hai lần.";
      seen[ch - 1] = true;
    }
    int tz = d["TzMin"]; if (tz < -720 || tz > 840) return "Múi giờ không hợp lệ."; }
  if (!saveFile(d)) return "Không lưu được offline.json";
  String e = applyDoc(d.as<JsonObjectConst>(), true);
  if (e.length()) return e;
  rev = s_rev;
  logf("Logic khi mất mạng đã đổi (rev %lu)", (unsigned long)s_rev);
  return "";
}

void offlineTest(uint32_t sec) {
  OLock l;
  if (sec == 0) { if (s_testUntil) logf("Dừng thử mất mạng"); s_testUntil = 0; return; }
  sec = min<uint32_t>(sec, 3600);
  s_testUntil = millis() + sec * 1000UL; if (!s_testUntil) s_testUntil = 1;
  logf("THỬ MẤT MẠNG %lu giây: logic offline chạy ngay (bỏ qua thời gian chờ)", (unsigned long)sec);
}

void offlineNoteManual(uint8_t changed) {
  OLock l;
  for (int i = 0; i < 8; i++)
    if ((changed & (1 << i)) && s_rt[i].active && !s_rt[i].manual) {
      s_rt[i].manual = true; s_rt[i].note = "đã thao tác tay — logic nhường tới khi có mạng lại";
      logf("DO%d đổi tay lúc đang chạy logic mất mạng → nhường", i + 1);
    }
}

void offlineTick() {
  uint32_t now = millis();
  // giá trị cho ngưỡng: đọc TRƯỚC khi giữ IoLock (thứ tự khoá: không lấy Lock khi đang giữ IoLock)
  double val[8] = {0}; bool valOk[8] = {false};
  Pol pol[8];
  { OLock l; for (int i = 0; i < 8; i++) pol[i] = effective(i); }
  for (int i = 0; i < 8; i++) {
    if (pol[i].mode != OMode::Threshold) continue;
    int32_t age = engineAgeMs(pol[i].field);
    valOk[i] = age >= 0 && (uint32_t)age <= pol[i].maxAgeSec * 1000UL && engineValue(pol[i].field, val[i]);
  }

  uint8_t cur = ioDo(), want = cur, ctrl = 0, manual = 0;
  {
  OLock l;
  bool test = s_testUntil && (int32_t)(s_testUntil - now) > 0;
  if (s_testUntil && !test) { s_testUntil = 0; logf("Hết thời gian thử mất mạng"); }
  uint32_t downMs = 0;
  bool down = safetyLinkDown(downMs) || test;
  if (!down) {
    if (s_wasDown) {
      bool any = false; for (auto& r : s_rt) any |= r.active;
      if (any) logf("Có mạng lại — dừng logic khi mất mạng, DO giữ trạng thái hiện tại (0x%02X)", ioDo());
      for (auto& r : s_rt) r = Rt();
    }
    s_wasDown = false;
    return;
  }
  s_wasDown = true;

  time_t t = time(nullptr);
  int localMin = (int)((((int64_t)t + (int64_t)s_tzMin * 60) % 86400 + 86400) % 86400 / 60);
  for (int i = 0; i < 8; i++) {
    const Pol& p = pol[i]; Rt& r = s_rt[i];
    if (p.mode == OMode::Hold) { r.note = ""; continue; }
    if (!r.active) {
      if (!test && downMs < p.delaySec * 1000UL) { r.note = "chờ " + String((p.delaySec * 1000UL - downMs + 999) / 1000) + " s"; continue; }
      r.active = true; r.since = now; r.thr = (cur >> i) & 1;
      logf("Mất mạng %lu s — DO%d chạy theo: %s", (unsigned long)(downMs / 1000), i + 1, describe(p).c_str());
    }
    if (r.manual) { manual |= 1 << i; continue; }
    bool on = false;
    switch (p.mode) {
      case OMode::Off: on = false; r.note = ""; break;
      case OMode::On: on = true; r.note = ""; break;
      case OMode::Schedule:
        if (!timeTrusted()) { on = false; r.note = "không có giờ tin được → tắt"; }
        else { on = inWindow(localMin, p.fromMin, p.toMin); r.note = String(on ? "trong" : "ngoài") + " khung giờ (" + fmtHm(localMin) + ")"; }
        break;
      case OMode::Follow: on = (((ioDi() >> (p.di - 1)) & 1) != 0) != p.invert; r.note = "DI" + String(p.di) + (on != p.invert ? " có" : " không"); break;
      case OMode::Threshold:
        if (!valOk[i]) { r.thr = false; on = false; r.note = "mất số liệu → tắt"; break; }
        if (p.on < p.off) { if (val[i] <= p.on) r.thr = true; else if (val[i] >= p.off) r.thr = false; }
        else { if (val[i] >= p.on) r.thr = true; else if (val[i] <= p.off) r.thr = false; }
        on = r.thr; r.note = "giá trị " + String(val[i], 2);
        break;
      case OMode::Cycle: {
        uint32_t per = p.onSec + p.offSec, ph = ((now - r.since) / 1000) % per;
        on = ph < p.onSec; r.note = String(on ? "đang chạy" : "đang nghỉ") + " (" + String(on ? p.onSec - ph : per - ph) + " s nữa đổi)";
        break;
      }
      default: break;
    }
    r.want = on;
    ctrl |= 1 << i;
    want = on ? (want | (1 << i)) : (want & ~(1 << i));
  }
  }   // hết OLock: KHÔNG giữ khoá logic khi lấy IoLock (localWrite giữ IoLock rồi mới gọi offlineNoteManual)
  if (!ctrl || want == cur) return;

  String extra[8];
  {
    IoLock io;
    cur = ioDo();
    uint8_t next = cur;
    for (int i = 0; i < 8; i++) {
      uint8_t b = 1 << i;
      if (!(ctrl & b) || (manual & b) || (want & b) == (cur & b)) continue;
      uint8_t m = (next & ~b) | (want & b);
      if (ioDoWaitMs(m)) { extra[i] = " · chờ đủ thời gian tối thiểu bật/tắt"; continue; }
      if (safeMode() && (want & b)) { extra[i] = " · chế độ an toàn: không bật"; continue; }
      next = m;
    }
    if (next != cur) {
      if (ioSetDo(next)) logf("Logic mất mạng: DO 0x%02X → 0x%02X", cur, next);
      else logf("Logic mất mạng: ghi DO 0x%02X lỗi", next);
    }
  }
  OLock l;
  for (int i = 0; i < 8; i++) if (extra[i].length()) s_rt[i].note += extra[i];
}
