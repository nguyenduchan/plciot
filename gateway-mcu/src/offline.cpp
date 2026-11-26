// LOGIC KHI MẤT MẠNG theo từng DO của board (chính sách lưu ở /offline.json, sửa bằng GatewayApp qua LAN hoặc từ xa: GatewayAdmin đề xuất →
// chủ trạm duyệt trên webapp). Webapp chỉ xem — trừ hẹn giờ (Timer) chủ trạm tự cài.
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
//
// CHƯƠNG TRÌNH LOGIC CỦA GATEWAY: /offline.json là chương trình DUY NHẤT của board (Rev + Sha), thay trọn gói mỗi lần sửa —
// tại chỗ (GatewayApp, LAN) hoặc từ xa theo yêu cầu của người dùng (GatewayAdmin → server → gw/<id>/rpc, xem docs/GATEWAY-LOGIC.md).
// Ngoài chính sách khi mất mạng, mỗi DO có thêm phần CHẶN LỆNH, LUÔN chạy (có mạng hay không, mọi nguồn ghi: webapp, LAN, slave):
//   Need      ≤ 4 điều kiện để được BẬT: {Di,Is} (DI có/không) hoặc {Field,Op:">="|"<=",Val,MaxAgeSec} (mất số liệu = không thoả)
//   NeedHold  đang bật mà mất điều kiện → tự TẮT (phao cạn → tắt bơm)
//   Block     liên động: không bật khi DO trong danh sách đang bật (hai chiều)
//   MaxOnSec  bật liên tục quá ngần này giây → tự TẮT (0 = không giới hạn)
//   Timer     HẸN GIỜ (chủ trạm tự cài trên webapp, cạnh nút điều khiển): ≤ 4 mục {On:"HH:MM"?, Off:"HH:MM"?, Days:[1..7] (1 = thứ Hai)}
//             — đúng phút On thì BẬT, đúng phút Off thì TẮT (theo sự kiện: giữa hai mốc người dùng vẫn điều khiển tay). Không có giờ tin được → bỏ qua.
// Lệnh TẮT luôn được phép. Logic khi mất mạng cũng phải qua các điều kiện này.
//
// ĐẦU RA LÀ THIẾT BỊ NGOÀI (mcu-0.4.0): ngoài DO1..DO8, chương trình điều khiển được field GHI ĐƯỢC của thiết bị RS485 (Modbus RTU,
// Unit ≠ 0) và Modbus TCP — mục {"Out":"<thiết bị>.<field>", …} (tối đa kMaxFieldOuts), cùng các mệnh đề như DO.
//   - Block trộn được: số = DO, chuỗi = field đầu ra (liên động hai chiều DO ↔ thiết bị ngoài).
//   - follow theo DI ({"Di":n}) hoặc theo field ({"Field":"tb.f"}).
//   - Trạng thái field đầu ra: đọc lại (field đọc-ghi) nếu còn mới; field CHỈ GHI = giá trị ghi gần nhất;
//     đọc cũ quá staleMs() (thiết bị mất kết nối) = KHÔNG RÕ → liên động coi như ĐANG BẬT (không bật mạo hiểm).
//   - Lệnh ghi do chương trình quyết định xếp hàng (s_fq) và chạy trên task đọc (engine.cpp): trao đổi RS485/TCP chậm
//     không làm chậm task io (DO/DI/watchdog).
//   - PC giữ lease (chế độ gateway): board không đọc thiết bị ngoài → các mục field tạm dừng (PC điều khiển).
//   - Chặn lệnh của người dùng tới field đầu ra: offlineGuardField (gọi trong engineWrite — mọi nguồn: webapp, LAN).
#include "gw.h"
#include <LittleFS.h>
#include <time.h>
#include <math.h>

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
  int di = 1; bool invert = false;   // follow: DI 1..8 (di = 0: theo field — dùng `field`)
  String field; double on = 0, off = 0; uint32_t maxAgeSec = 30;   // threshold
  uint32_t onSec = 600, offSec = 600;                                // cycle
  // chặn lệnh (luôn chạy)
  struct Cond { bool isDi = true; int di = 1, is = 1; String field; bool ge = true; double val = 0; uint32_t maxAgeSec = 60; };
  std::vector<Cond> need; bool needHold = false; uint8_t block = 0; uint32_t maxOnSec = 0;
  std::vector<String> blockF;        // liên động với đầu ra là field (thiết bị RS485/TCP)
  // phút trong ngày (-1 = không có); days bit0 = thứ Hai … bit6 = Chủ nhật.
  // CHẠY 1 LẦN (kiểu báo thức iPhone, mcu-0.4.0): day = số ngày từ 1970-01-01 (giờ địa phương), JSON {Date:"YYYY-MM-DD", Days:[]}.
  //   Days RỖNG cố ý: firmware cũ không hiểu Date sẽ từ chối chương trình thay vì chạy mỗi ngày.
  struct Tmr { int on = -1, off = -1; uint8_t days = 0x7F; int32_t day = -1; };
  std::vector<Tmr> timer;
  bool guarded() const { return !need.empty() || block || !blockF.empty() || maxOnSec; }
};
struct Rt { bool active = false, manual = false, thr = false, want = false; uint32_t since = 0; String note; };

/// Đầu ra là field của thiết bị ngoài (RS485 / Modbus TCP).
const int kMaxFieldOuts = 8;
struct FOut {
  String key, child, field;          // "<thiết bị>.<field>"
  Pol p; Rt rt; String why;
  bool fieldOk = false;              // điều kiện theo giá trị field của Need đang thoả (tính mỗi nhịp)
  uint32_t lastTry = 0; double lastVal = NAN;   // chống dồn lệnh: cùng giá trị thì chờ 5 s mới thử lại
  uint32_t onSince = 0;
};
/// Trạng thái một field đầu ra (mọi field nằm trong chương trình hoặc bị liên động tới).
struct FState { int8_t st = -1; bool writeOnly = false; double lastW = NAN; uint32_t wAt = 0; };
struct FBlk { uint8_t d = 0; std::vector<String> f; };   // field bị cấm bật khi các DO / field này bật (hai chiều)
struct FWrite { String child, field, why; double v; };
std::vector<FOut> s_fo;
std::map<String, FState> s_fst;
std::map<String, FBlk> s_fblk;
std::vector<String> s_dblkF[8];      // DO i bị cấm bật khi các field này bật (hoặc không rõ)
std::vector<FWrite> s_fq;            // lệnh ghi chờ task đọc thực hiện

Pol s_pol[8];
Rt s_rt[8];
int s_tzMin = 420;                   // Việt Nam UTC+7
uint32_t s_rev = 0;
String s_sha;                        // SHA-256 của file chương trình đang chạy (server/webapp đối chiếu)
uint8_t s_blk[8] = {0};              // liên động hai chiều đã tính: s_blk[i] = các DO không được bật cùng DO i
uint8_t s_fieldOk = 0xFF;            // bit i: các điều kiện theo GIÁ TRỊ field của DO i đang thoả (task io tính mỗi 500 ms)
String s_guardWhy[8];                // lý do gần nhất chương trình chặn / tự tắt DO i
int s_lastMin = -1;                  // phút (giờ địa phương) hẹn giờ đã xét gần nhất
uint32_t s_legacy[8] = {0};          // Field::lossOffSec theo chân
uint32_t s_testUntil = 0;
bool s_wasDown = false;
SemaphoreHandle_t s_mx = xSemaphoreCreateRecursiveMutex();   // chính sách + trạng thái chạy (API LAN ↔ task io)
struct OLock { OLock() { xSemaphoreTakeRecursive(s_mx, portMAX_DELAY); } ~OLock() { xSemaphoreGiveRecursive(s_mx); } };

int modeOf(const String& s) { for (int i = 0; i < 7; i++) if (s == kModes[i]) return i; return -1; }

/// Số ngày từ 1970-01-01 của ngày dương lịch (thuật toán days_from_civil).
int32_t civilDay(int y, int m, int d) {
  y -= m <= 2;
  int era = (y >= 0 ? y : y - 399) / 400;
  int yoe = y - era * 400, doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1, doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}
/// "YYYY-MM-DD" → số ngày; -1 = sai.
int32_t parseDate(const String& s) {
  int y, m, d;
  if (s.length() != 10 || sscanf(s.c_str(), "%4d-%2d-%2d", &y, &m, &d) != 3 || y < 2000 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return -1;
  int32_t n = civilDay(y, m, d);
  int32_t chk = civilDay(y, m, 1) + d - 1;
  if (d > 28 && civilDay(m == 12 ? y + 1 : y, m == 12 ? 1 : m + 1, 1) <= chk) return -1;   // 31/02 …
  return n;
}
String fmtDate(int32_t n) {
  // civil_from_days
  n += 719468; int era = (n >= 0 ? n : n - 146096) / 146097; unsigned doe = n - era * 146097;
  unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; int y = yoe + era * 400; unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned mp = (5 * doy + 2) / 153, d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9;
  char b[11]; snprintf(b, sizeof b, "%04d-%02u-%02u", y + (m <= 2), m, d); return b;
}
/// Mốc hẹn giờ k có đến lúc (phút m, thứ wd 0 = thứ Hai, ngày dn) không — on = mốc bật / tắt.
/// Mốc 1 lần qua nửa đêm (tắt < bật): giờ tắt rơi vào ngày hôm sau.
bool tmrHit(const Pol::Tmr& k, bool on, int m, int wd, int32_t dn) {
  if ((on ? k.on : k.off) != m) return false;
  if (k.day < 0) return k.days & (1 << wd);
  return dn == k.day + (!on && k.on >= 0 && k.off < k.on ? 1 : 0);
}

/// "HH:MM" → phút trong ngày; -1 = sai.
int hhmm(const String& s) {
  int h, m; char c;
  if (s.length() < 3 || s.length() > 5 || sscanf(s.c_str(), "%d%c%d", &h, &c, &m) != 3 || c != ':' || h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}
String fmtHm(int m) { char b[6]; snprintf(b, sizeof b, "%02d:%02d", m / 60, m % 60); return b; }

/// field "child.field" có trong cấu hình và đọc được. Lấy Lock: KHÔNG gọi khi đang giữ OLock.
bool fieldReadable(const String& key) {
  Lock l;
  for (auto& f : g_cfg.pack) if (f.child + "." + f.field == key && f.access != Access::Write) return true;
  return false;
}
/// field "child.field" là đầu ra của thiết bị NGOÀI (RS485 Unit ≠ 0 / Modbus TCP) và ghi được. Lấy Lock.
bool fieldOutput(const String& key, bool* writeOnly = nullptr) {
  Lock l;
  for (auto& f : g_cfg.pack)
    if (f.child + "." + f.field == key && f.access != Access::Read && !f.localIo() && (f.proto == Proto::ModbusRtu || f.proto == Proto::ModbusTcp)) {
      if (writeOnly) *writeOnly = f.access == Access::Write;
      return true;
    }
  return false;
}
/// Giá trị đọc cũ hơn ngần này = thiết bị mất kết nối → trạng thái KHÔNG RÕ.
uint32_t staleMs() { return max<uint32_t>(10000, (uint32_t)max(0, g_cfg.pollMs) * 5); }

/// Chính sách thật sự áp dụng cho chân ch (file > LossOffSec cũ > giữ nguyên).
Pol effective(int ch) {
  if (s_pol[ch].set) return s_pol[ch];
  Pol p;
  if (s_legacy[ch]) { p.mode = OMode::Off; p.delaySec = s_legacy[ch]; }
  return p;
}

/// Đọc một chính sách từ JSON (API / file). "" = hợp lệ, còn lại câu báo lỗi tiếng Việt (hiện trên GatewayApp).
String parse(JsonObjectConst o, Pol& p, int& ch, String& out) {
  out = o["Out"] | ""; out.trim();
  ch = out.length() ? 0 : (o["Ch"] | 0);
  String w = out.length() ? out : "DO" + String(ch);
  if (out.length()) { if (!fieldOutput(out)) return w + ": không phải field ghi được của thiết bị RS485 / Modbus TCP trong cấu hình."; }
  else if (ch < 1 || ch > 8) return "Chân DO phải từ 1 đến 8.";
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
      if (o["Field"].is<const char*>()) {   // follow theo field (vd cảm biến hiện diện RS485, trạng thái PLC)
        p.di = 0; p.field = o["Field"] | ""; p.field.trim();
        if (!fieldReadable(p.field)) return w + ": follow theo \"" + p.field + "\" — không có trong cấu hình (hoặc là field chỉ ghi).";
      } else if (p.di < 1 || p.di > 8) return w + ": chân DI phải từ 1 đến 8.";
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
      if (!fieldReadable(p.field)) return w + ": giá trị \"" + p.field + "\" không có trong cấu hình (hoặc là field chỉ ghi).";
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
  // ---- chặn lệnh (luôn chạy)
  JsonArrayConst na = o["Need"].as<JsonArrayConst>();
  if (na.size() > 4) return w + ": tối đa 4 điều kiện cho phép bật.";
  for (JsonObjectConst c : na) {
    Pol::Cond k;
    if (!c["Di"].isNull()) {
      k.isDi = true; k.di = c["Di"] | 0; k.is = c["Is"] | 1;
      if (k.di < 1 || k.di > 8) return w + ": điều kiện DI phải từ 1 đến 8.";
      if (k.is != 0 && k.is != 1) return w + ": điều kiện DI chỉ nhận 0 hoặc 1.";
    } else {
      k.isDi = false; k.field = c["Field"] | ""; k.field.trim();
      String op = c["Op"] | "";
      if (!k.field.length()) return w + ": điều kiện cần DI hoặc giá trị theo dõi.";
      if (op != ">=" && op != "<=") return w + ": điều kiện giá trị chỉ dùng >= hoặc <=.";
      if (!c["Val"].is<double>()) return w + ": điều kiện giá trị thiếu ngưỡng.";
      k.ge = op == ">="; k.val = c["Val"];
      long a = c["MaxAgeSec"] | 60L;
      if (a < 1 || a > 86400) return w + ": thời gian mất số liệu phải từ 1 đến 86400 giây.";
      k.maxAgeSec = (uint32_t)a;
      if (!fieldReadable(k.field)) return w + ": giá trị \"" + k.field + "\" không có trong cấu hình (hoặc là field chỉ ghi).";
    }
    p.need.push_back(k);
  }
  p.needHold = o["NeedHold"] | false;
  if (p.needHold && p.need.empty()) return w + ": \"tự tắt khi mất điều kiện\" cần ít nhất một điều kiện.";
  for (JsonVariantConst b : o["Block"].as<JsonArrayConst>()) {
    if (b.is<const char*>()) {   // đầu ra field của thiết bị ngoài
      String k = b | ""; k.trim();
      if (k == out || !fieldOutput(k)) return w + ": liên động \"" + k + "\" phải là đầu ra khác (field ghi được của thiết bị RS485 / Modbus TCP).";
      bool dup = false; for (auto& x : p.blockF) dup |= x == k;
      if (!dup) p.blockF.push_back(k);
      continue;
    }
    int c = b | 0;
    if (c < 1 || c > 8 || c == ch) return w + ": liên động phải là DO khác (1 đến 8).";
    p.block |= 1 << (c - 1);
  }
  long mo = o["MaxOnSec"] | 0L;
  if (mo < 0 || mo > 604800) return w + ": thời gian chạy tối đa phải từ 0 đến 604800 giây (7 ngày).";
  p.maxOnSec = (uint32_t)mo;
  JsonArrayConst ta = o["Timer"].as<JsonArrayConst>();
  if (ta.size() > 4) return w + ": tối đa 4 mốc hẹn giờ.";
  for (JsonObjectConst t : ta) {
    Pol::Tmr k;
    if (!t["On"].isNull()) { k.on = hhmm(t["On"] | ""); if (k.on < 0) return w + ": giờ bật hẹn giờ phải dạng HH:MM."; }
    if (!t["Off"].isNull()) { k.off = hhmm(t["Off"] | ""); if (k.off < 0) return w + ": giờ tắt hẹn giờ phải dạng HH:MM."; }
    if (k.on < 0 && k.off < 0) return w + ": mốc hẹn giờ cần giờ bật hoặc giờ tắt.";
    if (k.on == k.off) return w + ": giờ bật và giờ tắt của hẹn giờ phải khác nhau.";
    if (!t["Date"].isNull()) {   // chạy 1 lần
      k.day = parseDate(t["Date"] | "");
      if (k.day < 0) return w + ": ngày hẹn giờ phải dạng YYYY-MM-DD.";
      if (t["Days"].as<JsonArrayConst>().size()) return w + ": hẹn giờ 1 lần không kèm ngày lặp lại.";
    } else if (!t["Days"].isNull()) {
      k.days = 0;
      for (JsonVariantConst dv : t["Days"].as<JsonArrayConst>()) { int dd = dv | 0; if (dd < 1 || dd > 7) return w + ": ngày hẹn giờ phải từ 1 (thứ Hai) đến 7 (Chủ nhật)."; k.days |= 1 << (dd - 1); }
      if (!k.days) return w + ": hẹn giờ phải chọn ít nhất một ngày.";
    }
    p.timer.push_back(k);
  }
  return "";
}

String condText(const Pol::Cond& k) {
  if (k.isDi) return "DI" + String(k.di) + (k.is ? " có" : " không");
  return k.field + (k.ge ? " ≥ " : " ≤ ") + String(k.val, 2);
}

/// Mô tả phần chặn lệnh (GatewayApp + log). "" = không chặn gì.
String guardText(const Pol& p) {
  String s;
  for (auto& k : p.need) s += (s.length() ? " và " : "chỉ bật khi ") + condText(k);
  if (p.needHold) s += " (mất điều kiện → tắt)";
  if (p.block || !p.blockF.empty()) { s += s.length() ? "; " : ""; s += "không cùng"; for (int j = 0; j < 8; j++) if (p.block & (1 << j)) s += " DO" + String(j + 1); for (auto& k : p.blockF) s += " " + k; }
  if (p.maxOnSec) { s += s.length() ? "; " : ""; s += "tự tắt sau " + String(p.maxOnSec) + " s"; }
  for (auto& k : p.timer) {
    s += s.length() ? "; " : ""; s += "hẹn giờ";
    if (k.on >= 0) s += " bật " + fmtHm(k.on);
    if (k.off >= 0) s += " tắt " + fmtHm(k.off);
    if (k.day >= 0) s += " (1 lần " + fmtDate(k.day) + ")";
    else if (k.days != 0x7F) { s += " ("; for (int j = 0; j < 7; j++) if (k.days & (1 << j)) s += j == 6 ? "CN" : "T" + String(j + 2); s += ")"; }
  }
  return s;
}

/// Điều kiện DI của chân thoả không (đọc trực tiếp DI đã lọc rung — không cần khoá).
bool diCondsOk(const Pol& p, uint8_t di) {
  for (auto& k : p.need) if (k.isDi && (((di >> (k.di - 1)) & 1) != k.is)) return false;
  return true;
}
/// Điều kiện đầu tiên KHÔNG thoả (để báo lý do). Gọi khi đã biết là chặn.
String failedCond(int i, const Pol& p, uint8_t di) {
  for (auto& k : p.need) if (k.isDi && (((di >> (k.di - 1)) & 1) != k.is)) return condText(k);
  if (!((s_fieldOk >> i) & 1)) for (auto& k : p.need) if (!k.isDi) return condText(k) + " (hoặc mất số liệu)";
  return "điều kiện";
}

/// ch: chỉ số DO (0..7) — hoặc out ≠ "" cho đầu ra field.
void toJson(int ch, const Pol& p, JsonObject o, const String& out = String()) {
  if (out.length()) o["Out"] = out; else o["Ch"] = ch + 1;
  o["Mode"] = kModes[(int)p.mode]; o["DelaySec"] = p.delaySec;
  switch (p.mode) {
    case OMode::Schedule: o["From"] = fmtHm(p.fromMin); o["To"] = fmtHm(p.toMin); break;
    case OMode::Follow: if (p.di) o["Di"] = p.di; else o["Field"] = p.field; o["Invert"] = p.invert; break;
    case OMode::Threshold: o["Field"] = p.field; o["On"] = p.on; o["Off"] = p.off; o["MaxAgeSec"] = p.maxAgeSec; break;
    case OMode::Cycle: o["OnSec"] = p.onSec; o["OffSec"] = p.offSec; break;
    default: break;
  }
  if (!p.need.empty()) {
    JsonArray a = o["Need"].to<JsonArray>();
    for (auto& k : p.need) {
      JsonObject c = a.add<JsonObject>();
      if (k.isDi) { c["Di"] = k.di; c["Is"] = k.is; }
      else { c["Field"] = k.field; c["Op"] = k.ge ? ">=" : "<="; c["Val"] = k.val; c["MaxAgeSec"] = k.maxAgeSec; }
    }
    if (p.needHold) o["NeedHold"] = true;
  }
  if (p.block || !p.blockF.empty()) { JsonArray a = o["Block"].to<JsonArray>(); for (int j = 0; j < 8; j++) if (p.block & (1 << j)) a.add(j + 1); for (auto& k : p.blockF) a.add(k); }
  if (p.maxOnSec) o["MaxOnSec"] = p.maxOnSec;
  if (!p.timer.empty()) {
    JsonArray a = o["Timer"].to<JsonArray>();
    for (auto& k : p.timer) {
      JsonObject t = a.add<JsonObject>();
      if (k.on >= 0) t["On"] = fmtHm(k.on);
      if (k.off >= 0) t["Off"] = fmtHm(k.off);
      if (k.day >= 0) { t["Date"] = fmtDate(k.day); t["Days"].to<JsonArray>(); }
      else if (k.days != 0x7F) { JsonArray dd = t["Days"].to<JsonArray>(); for (int j = 0; j < 7; j++) if (k.days & (1 << j)) dd.add(j + 1); }
    }
  }
}

/// Mô tả ngắn tiếng Việt (log + GatewayApp).
String describe(const Pol& p) {
  switch (p.mode) {
    case OMode::Hold: return "giữ nguyên";
    case OMode::Off: return "tắt";
    case OMode::On: return "bật";
    case OMode::Schedule: return "bật " + fmtHm(p.fromMin) + " → tắt " + fmtHm(p.toMin);
    case OMode::Follow: return String(p.invert ? "ngược " : "theo ") + (p.di ? "DI" + String(p.di) : p.field);
    case OMode::Threshold: return p.field + (p.on < p.off ? " ≤ " : " ≥ ") + String(p.on, 2) + " bật, " + (p.on < p.off ? "≥ " : "≤ ") + String(p.off, 2) + " tắt";
    case OMode::Cycle: return "bật " + String(p.onSec) + " s / nghỉ " + String(p.offSec) + " s";
  }
  return "";
}

String shaOf(const JsonDocument& d) { String s; serializeJson(d, s); return sha256Hex((const uint8_t*)s.c_str(), s.length()); }

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
  std::vector<FOut> nf;
  if (tz < -720 || tz > 840) return "Múi giờ không hợp lệ.";
  for (JsonObjectConst o : d["Do"].as<JsonArrayConst>()) {
    Pol p; int ch; String out; String e = parse(o, p, ch, out);
    if (e.length()) { if (strict) return e; logf("offline.json: bỏ %s", e.c_str()); continue; }
    if (out.length()) {
      bool dup = false; for (auto& x : nf) dup |= x.key == out;
      if (dup) { if (strict) return out + " bị khai hai lần."; continue; }
      if ((int)nf.size() >= kMaxFieldOuts) { if (strict) return "Tối đa " + String(kMaxFieldOuts) + " đầu ra là thiết bị RS485 / Modbus TCP."; continue; }
      FOut f; f.key = out; f.p = p; int dot = out.indexOf('.'); f.child = out.substring(0, dot); f.field = out.substring(dot + 1);
      nf.push_back(f);
      continue;
    }
    if (np[ch - 1].set && strict) return "DO" + String(ch) + " bị khai hai lần.";
    np[ch - 1] = p;
  }
  // liên động hai chiều giữa DO và field đầu ra
  std::map<String, FBlk> fb; std::vector<String> dbf[8];
  auto addF = [](std::vector<String>& v, const String& k) { for (auto& x : v) if (x == k) return; v.push_back(k); };
  for (int i = 0; i < 8; i++) for (auto& k : np[i].blockF) { addF(dbf[i], k); fb[k].d |= 1 << i; }
  for (auto& f : nf) {
    for (int j = 0; j < 8; j++) if (f.p.block & (1 << j)) { fb[f.key].d |= 1 << j; addF(dbf[j], f.key); }
    for (auto& k : f.p.blockF) { addF(fb[f.key].f, k); addF(fb[k].f, f.key); }
  }
  std::map<String, FState> fst;
  for (auto& f : nf) fst[f.key];
  for (auto& kv : fb) fst[kv.first];
  for (auto& kv : fst) fieldOutput(kv.first, &kv.second.writeOnly);   // Lock: trước OLock
  OLock l;
  for (auto& kv : fst) { auto it = s_fst.find(kv.first); if (it != s_fst.end()) { kv.second.lastW = it->second.lastW; kv.second.wAt = it->second.wAt; } }   // giữ giá trị ghi gần nhất (field chỉ ghi)
  s_fo.swap(nf); s_fblk.swap(fb); s_fst.swap(fst); s_fq.clear();
  for (int i = 0; i < 8; i++) s_dblkF[i] = dbf[i];
  for (int i = 0; i < 8; i++) { s_pol[i] = np[i]; s_rt[i] = Rt(); s_guardWhy[i] = ""; s_blk[i] = 0; }
  for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) if (np[i].block & (1 << j)) { s_blk[i] |= 1 << j; s_blk[j] |= 1 << i; }   // liên động hai chiều
  s_fieldOk = 0;   // chân có điều kiện theo giá trị: chưa tính → coi như chưa thoả (task io tính lại sau ≤ 500 ms)
  for (int i = 0; i < 8; i++) { bool hasField = false; for (auto& k : np[i].need) hasField |= !k.isDi; if (!hasField) s_fieldOk |= 1 << i; }
  s_tzMin = tz;
  s_rev = d["Rev"] | 0;
  return "";
}

bool inWindow(int m, int from, int to) { return from < to ? (m >= from && m < to) : (m >= from || m < to); }

/// Trạng thái field đầu ra (đang giữ OLock): 1 bật, 0 tắt, -1 không rõ.
int8_t fstate(const String& k) { auto it = s_fst.find(k); return it == s_fst.end() ? -1 : it->second.st; }
FOut* fout(const String& k) { for (auto& f : s_fo) if (f.key == k) return &f; return nullptr; }

/// Xếp lệnh ghi field (đang giữ OLock). retry = false: hẹn giờ — ghi ngay, không chờ 5 s.
void fwant(FOut& f, double v, const String& why, uint32_t now, bool retry = true) {
  int8_t cur = fstate(f.key);
  if (cur >= 0 && (cur != 0) == (v != 0)) return;
  if (retry && now - f.lastTry < 5000 && f.lastVal == v) return;   // vừa thử cùng giá trị: chờ đọc lại, không dồn lệnh
  f.lastTry = now; f.lastVal = v;
  for (auto& q : s_fq) if (q.child == f.child && q.field == f.field) { q.v = v; q.why = why; return; }
  if (s_fq.size() < 16) s_fq.push_back({f.child, f.field, why, v});
}
}  // namespace

void offlineBegin() {
  File f = LittleFS.open(kPath, "r");
  if (!f) { LittleFS.remove(kTmp); return; }   // chưa cài: mọi chân giữ nguyên
  JsonDocument d; bool ok = !deserializeJson(d, f); f.close();
  if (!ok) { logf("offline.json hỏng — mọi DO giữ nguyên khi mất mạng"); return; }
  applyDoc(d.as<JsonObjectConst>(), false);
  { OLock l; s_sha = shaOf(d); }
  int n = 0; for (auto& p : s_pol) if (p.set && p.mode != OMode::Hold) n++;
  logf("Logic khi mất mạng: %d chân DO có chính sách (rev %lu)", n, (unsigned long)s_rev);
}

void offlineLegacyLoss(const uint32_t* sec8) { OLock l; for (int i = 0; i < 8; i++) s_legacy[i] = sec8[i]; }

void offlineGet(JsonDocument& out) {
  OLock l;
  out["Rev"] = s_rev; out["TzMin"] = s_tzMin; out["Sha"] = s_sha;
  JsonArray a = out["Do"].to<JsonArray>();
  for (int i = 0; i < 8; i++) if (s_pol[i].set) toJson(i, s_pol[i], a.add<JsonObject>());
  for (auto& f : s_fo) toJson(0, f.p, a.add<JsonObject>(), f.key);
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
    String g = guardText(p); if (g.length()) o["Guard"] = g;
    if (s_guardWhy[i].length()) o["GuardWhy"] = s_guardWhy[i];
  }
  // đầu ra field: Ch = 0 (GatewayApp cũ bỏ qua), Key = "<thiết bị>.<field>", Out = 1/0, State = -1 khi không rõ (mất kết nối)
  for (auto& f : s_fo) {
    JsonObject o = ca.add<JsonObject>();
    int8_t s = fstate(f.key);
    o["Ch"] = 0; o["Key"] = f.key; o["Mode"] = kModes[(int)f.p.mode]; o["Active"] = f.rt.active; o["Manual"] = f.rt.manual;
    o["Out"] = s > 0 ? 1 : 0; o["State"] = s; o["Text"] = describe(f.p); o["Note"] = f.rt.note;
    String g = guardText(f.p); if (g.length()) o["Guard"] = g;
    if (f.why.length()) o["GuardWhy"] = f.why;
  }
}

void offlineCloud(JsonObject out) {
  OLock l;
  out["rev"] = s_rev; out["sha"] = s_sha; out["tz"] = s_tzMin;
  JsonArray a = out["do"].to<JsonArray>();
  for (int i = 0; i < 8; i++) if (s_pol[i].set) toJson(i, s_pol[i], a.add<JsonObject>());
  for (int i = 0; i < 8; i++) if (!s_pol[i].set && s_legacy[i]) { JsonObject o = a.add<JsonObject>(); o["Ch"] = i + 1; o["Mode"] = "off"; o["DelaySec"] = s_legacy[i]; }
  for (auto& f : s_fo) toJson(0, f.p, a.add<JsonObject>(), f.key);
}

String offlineGuard(uint8_t cur, uint8_t next, String& why) {
  uint8_t up = next & ~cur;
  if (!up) return "";   // TẮT luôn được phép
  uint8_t di = ioDi();
  OLock l;
  for (int i = 0; i < 8; i++) {
    if (!(up & (1 << i))) continue;
    const Pol& p = s_pol[i];
    if (!p.set) continue;
    if (!diCondsOk(p, di) || !((s_fieldOk >> i) & 1)) {
      why = "DO" + String(i + 1) + ": chưa đủ điều kiện để bật — " + failedCond(i, p, di);
      s_guardWhy[i] = why; return "logic_need";
    }
    if (next & s_blk[i]) {
      int j = 0; while (j < 8 && !((next & s_blk[i]) & (1 << j))) j++;
      why = "DO" + String(i + 1) + ": liên động — DO" + String(j + 1) + " đang bật";
      s_guardWhy[i] = why; return "logic_interlock";
    }
    for (auto& k : s_dblkF[i]) {   // liên động với thiết bị RS485/TCP: đang bật HOẶC không rõ (mất kết nối) → không bật
      int8_t st = fstate(k);
      if (st == 0) continue;
      why = "DO" + String(i + 1) + ": liên động — " + (st > 0 ? k + " đang bật" : "không rõ trạng thái " + k + " (mất kết nối thiết bị)");
      s_guardWhy[i] = why; return "logic_interlock";
    }
  }
  return "";
}

String offlineGuardField(const String& key, double v, bool byLogic, String& why) {
  if (v == 0) return "";   // TẮT luôn được phép
  uint8_t di = ioDi(), d = ioDo();
  OLock l;
  if (fstate(key) > 0) return "";   // đang bật: gửi lại / đổi mức không phải "bật mới"
  FOut* f = fout(key);
  if (f) {
    if (byLogic && safeMode()) { why = key + ": chế độ an toàn — không bật"; f->why = why; return "safe_mode"; }
    if (!diCondsOk(f->p, di) || !f->fieldOk) {
      String fc;
      for (auto& k : f->p.need) if (k.isDi && (((di >> (k.di - 1)) & 1) != k.is)) { fc = condText(k); break; }
      if (!fc.length()) for (auto& k : f->p.need) if (!k.isDi) { fc = condText(k) + " (hoặc mất số liệu)"; break; }
      why = key + ": chưa đủ điều kiện để bật — " + fc;
      f->why = why; return "logic_need";
    }
  }
  auto it = s_fblk.find(key);
  if (it != s_fblk.end()) {
    if (d & it->second.d) {
      int j = 0; while (j < 8 && !((d & it->second.d) & (1 << j))) j++;
      why = key + ": liên động — DO" + String(j + 1) + " đang bật";
      if (f) f->why = why;
      return "logic_interlock";
    }
    for (auto& k : it->second.f) {
      int8_t st = fstate(k);
      if (st == 0) continue;
      why = key + ": liên động — " + (st > 0 ? k + " đang bật" : "không rõ trạng thái " + k + " (mất kết nối thiết bị)");
      if (f) f->why = why;
      return "logic_interlock";
    }
  }
  return "";
}

void offlineFieldWritten(const String& key, double v, bool byLogic) {
  OLock l;
  auto it = s_fst.find(key);
  if (it == s_fst.end()) return;
  it->second.lastW = v; it->second.wAt = millis(); it->second.st = v != 0;
  FOut* f = fout(key);
  if (f && !byLogic && f->rt.active && !f->rt.manual) {
    f->rt.manual = true; f->rt.note = "đã thao tác tay — logic nhường tới khi có mạng lại";
    logf("%s đổi tay lúc đang chạy logic mất mạng → nhường", key.c_str());
  }
}

void offlineDrainWrites() {
  std::vector<FWrite> q;
  { OLock l; q.swap(s_fq); }
  for (auto& w : q) {
    String e = engineWrite(w.child, w.field, w.v, false, true);
    String key = w.child + "." + w.field;
    OLock l;
    FOut* f = fout(key);
    if (!f) continue;
    f->why = key + ": " + w.why + (e.length() ? " — không thực hiện: " + e : String(""));
    logf("Chương trình logic: %s = %g (%s)%s", key.c_str(), w.v, w.why.c_str(), e.length() ? (" lỗi " + e).c_str() : "");
    if (!e.length()) cloudExpedite();
  }
}

String offlinePut(JsonObjectConst in, uint32_t& rev, const String& via) {
  if (!in["Rev"].isNull() && (uint32_t)(in["Rev"] | 0) != s_rev) return "rev_conflict";   // người khác vừa sửa: tải lại rồi sửa tiếp
  JsonDocument d; d["Rev"] = s_rev + 1; d["TzMin"] = in["TzMin"] | 420;
  JsonArray a = d["Do"].to<JsonArray>();
  for (JsonObjectConst o : in["Do"].as<JsonArrayConst>()) a.add(o);
  // kiểm hết trước khi ghi (parse đủ mọi lỗi), rồi mới lưu và áp
  { Pol p; int ch; String out; bool seen[8] = {false}; std::vector<String> seenF;
    for (JsonObjectConst o : d["Do"].as<JsonArrayConst>()) {
      String e = parse(o, p, ch, out); if (e.length()) return e;
      if (out.length()) {
        for (auto& k : seenF) if (k == out) return out + " bị khai hai lần.";
        seenF.push_back(out);
        if ((int)seenF.size() > kMaxFieldOuts) return "Tối đa " + String(kMaxFieldOuts) + " đầu ra là thiết bị RS485 / Modbus TCP.";
        continue;
      }
      if (seen[ch - 1]) return "DO" + String(ch) + " bị khai hai lần.";
      seen[ch - 1] = true;
    }
    int tz = d["TzMin"]; if (tz < -720 || tz > 840) return "Múi giờ không hợp lệ."; }
  if (!saveFile(d)) return "Không lưu được offline.json";
  String e = applyDoc(d.as<JsonObjectConst>(), true);
  if (e.length()) return e;
  String sha = shaOf(d);
  { OLock l; s_sha = sha; rev = s_rev; }
  logf("Chương trình logic đã đổi (rev %lu, %s)", (unsigned long)rev, via.c_str());
  // báo chủ trạm (thông báo về điện thoại) + gửi lại bản tin config để server lưu bản mới (webapp xem sơ đồ)
  evLog("logic_changed", "Chương trình logic đổi → rev " + String(rev) + " (" + via + ", " + sha.substring(0, 8) + ")", true);
  cloudRestart();
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
  std::vector<Pol> pol(8);   // heap, không phải stack: task io chỉ có vài KB stack (Pol chứa String/vector)
  { OLock l; for (int i = 0; i < 8; i++) pol[i] = effective(i); }
  for (int i = 0; i < 8; i++) {
    if (pol[i].mode != OMode::Threshold) continue;
    int32_t age = engineAgeMs(pol[i].field);
    valOk[i] = age >= 0 && (uint32_t)age <= pol[i].maxAgeSec * 1000UL && engineValue(pol[i].field, val[i]);
  }
  // điều kiện theo giá trị field của phần chặn lệnh (đọc ngoài OLock)
  uint8_t fieldOk = 0;
  for (int i = 0; i < 8; i++) {
    bool ok = true;
    for (auto& k : pol[i].need) {
      if (k.isDi) continue;
      double v; int32_t age = engineAgeMs(k.field);
      if (age < 0 || (uint32_t)age > k.maxAgeSec * 1000UL || !engineValue(k.field, v) || (k.ge ? v < k.val : v > k.val)) { ok = false; break; }
    }
    if (ok) fieldOk |= 1 << i;
  }
  // follow theo field của DO (mất số liệu → coi như 0)
  bool folOn[8] = {false};
  for (int i = 0; i < 8; i++) {
    if (pol[i].mode != OMode::Follow || pol[i].di) continue;
    double v; int32_t age = engineAgeMs(pol[i].field);
    folOn[i] = age >= 0 && (uint32_t)age <= staleMs() && engineValue(pol[i].field, v) && v != 0;
  }

  // ---- ĐẦU RA FIELD (thiết bị RS485 / Modbus TCP): đọc trạng thái + điều kiện TRƯỚC khi giữ OLock (engine* lấy Lock)
  struct FSnap { String key; Pol p; bool fieldOk = true, valOk = false, folOn = false; double val = 0; };
  std::vector<FSnap> fs;
  std::vector<std::pair<String, bool>> tracked;   // key, writeOnly
  { OLock l; for (auto& f : s_fo) fs.push_back({f.key, f.p}); for (auto& kv : s_fst) tracked.push_back({kv.first, kv.second.writeOnly}); }
  const uint32_t stale = staleMs();
  struct RB { bool fresh = false; double v = 0; uint32_t at = 0; };
  std::vector<RB> rb(tracked.size());
  for (size_t k = 0; k < tracked.size(); k++) {
    if (tracked[k].second) continue;   // chỉ ghi: không đọc lại được
    int32_t age = engineAgeMs(tracked[k].first);
    rb[k].fresh = age >= 0 && (uint32_t)age <= stale && engineValue(tracked[k].first, rb[k].v);
    rb[k].at = age >= 0 ? now - (uint32_t)age : 0;
  }
  for (auto& f : fs) {
    for (auto& k : f.p.need) {
      if (k.isDi) continue;
      double v; int32_t age = engineAgeMs(k.field);
      if (age < 0 || (uint32_t)age > k.maxAgeSec * 1000UL || !engineValue(k.field, v) || (k.ge ? v < k.val : v > k.val)) { f.fieldOk = false; break; }
    }
    if (f.p.mode == OMode::Threshold) { int32_t age = engineAgeMs(f.p.field); f.valOk = age >= 0 && (uint32_t)age <= f.p.maxAgeSec * 1000UL && engineValue(f.p.field, f.val); }
    if (f.p.mode == OMode::Follow) {
      if (f.p.di) f.folOn = ((ioDi() >> (f.p.di - 1)) & 1) != 0;
      else { double v; int32_t age = engineAgeMs(f.p.field); f.folOn = age >= 0 && (uint32_t)age <= stale && engineValue(f.p.field, v) && v != 0; }
    }
  }
  const bool lease = leaseActive();
  {
    OLock l;
    for (size_t k = 0; k < tracked.size(); k++) {
      auto it = s_fst.find(tracked[k].first);
      if (it == s_fst.end()) continue;   // chương trình vừa đổi
      FState& st = it->second;
      bool wroteRecently = st.wAt && (int32_t)(now - st.wAt) < (int32_t)stale && !std::isnan(st.lastW);   // có dấu: lần ghi ở task khác có thể mới hơn now
      if (st.writeOnly) st.st = std::isnan(st.lastW) ? -1 : (st.lastW != 0);
      else if (rb[k].fresh && !(wroteRecently && (int32_t)(rb[k].at - st.wAt) < 0)) st.st = rb[k].v != 0;   // kết quả đọc cũ hơn lần ghi: chưa tính
      else if (wroteRecently) st.st = st.lastW != 0;
      else st.st = -1;   // thiết bị không trả lời: KHÔNG RÕ
      if (lease) st.st = st.writeOnly ? st.st : -1;   // PC giữ lease: board không đọc thiết bị ngoài
    }
    for (auto& f : fs) if (FOut* o = fout(f.key)) {
      o->fieldOk = f.fieldOk;
      int8_t st = fstate(f.key);
      if (st > 0) { if (!o->onSince) o->onSince = now; } else if (st == 0) o->onSince = 0;
      if (lease) { o->rt.note = "PC đang giữ quyền điều khiển (chế độ gateway) — logic thiết bị ngoài tạm dừng"; continue; }
      // luôn chạy: mất điều kiện / chạy quá lâu → tự TẮT
      if (st > 0 && f.p.needHold && (!diCondsOk(f.p, ioDi()) || !f.fieldOk)) fwant(*o, 0, "mất điều kiện → tự tắt", now);
      else if (st > 0 && f.p.maxOnSec && o->onSince && (int32_t)(now - o->onSince) >= (int32_t)(f.p.maxOnSec * 1000UL)) fwant(*o, 0, "chạy quá " + String(f.p.maxOnSec) + " s → tự tắt", now);
    }
  }

  // ---- HẸN GIỜ (luôn chạy): đúng phút On → bật, đúng phút Off → tắt. Bật vẫn phải qua điều kiện + liên động.
  if (timeTrusted()) {
    time_t t = time(nullptr);
    int64_t loc = (int64_t)t + (int64_t)s_tzMin * 60;
    int m = (int)((loc % 86400 + 86400) % 86400 / 60);
    int wd = (int)(((loc / 86400) % 7 + 7 + 3) % 7);   // 1970-01-01 là thứ Năm → 0 = thứ Hai
    int32_t dn = (int32_t)(loc >= 0 ? loc / 86400 : (loc - 86399) / 86400);   // ngày (giờ địa phương) — hẹn giờ 1 lần
    if (m != s_lastMin) {
      bool first = s_lastMin < 0;
      s_lastMin = m;
      uint8_t onM = 0, offM = 0;
      if (!first && !lease) {
        OLock l;
        for (auto& f : s_fo) for (auto& k : f.p.timer) {
          if (tmrHit(k, true, m, wd, dn)) { f.lastTry = 0; fwant(f, 1, "hẹn giờ bật lúc " + fmtHm(m), now, false); }
          if (tmrHit(k, false, m, wd, dn)) { f.lastTry = 0; fwant(f, 0, "hẹn giờ tắt lúc " + fmtHm(m), now, false); }
        }
      }
      if (!first) for (int i = 0; i < 8; i++) for (auto& k : pol[i].timer) {
        if (tmrHit(k, true, m, wd, dn)) onM |= 1 << i;
        if (tmrHit(k, false, m, wd, dn)) offM |= 1 << i;
      }
      if (onM | offM) {
        String why[8]; uint8_t from, to;
        {
          IoLock io;
          from = ioDo(); to = (from | onM) & ~offM;
          for (int i = 0; i < 8; i++) {
            uint8_t b = 1 << i;
            if ((to & b) == (from & b)) continue;
            uint8_t cand = (to & b) ? (from | b) : (from & ~b);
            String w;
            if ((to & b) && safeMode()) { to = (to & ~b) | (from & b); why[i] = "chế độ an toàn: không bật"; continue; }
            if ((to & b) && offlineGuard(from, cand, w).length()) { to = (to & ~b) | (from & b); why[i] = w.substring(w.indexOf(':') + 2); continue; }
            if (ioDoWaitMs(cand)) { to = (to & ~b) | (from & b); why[i] = "chưa đủ thời gian tối thiểu bật/tắt"; continue; }
          }
          if (to != from && !ioSetDo(to)) to = from;
        }
        String act;
        {
          OLock l;
          for (int i = 0; i < 8; i++) {
            uint8_t b = 1 << i;
            if (!((onM | offM) & b)) continue;
            s_guardWhy[i] = "DO" + String(i + 1) + ": hẹn giờ " + ((onM & b) ? "bật" : "tắt") + " lúc " + fmtHm(m) + (why[i].length() ? " — không thực hiện: " + why[i] : String(""));
            logf("Chương trình logic: %s", s_guardWhy[i].c_str());
            if ((from ^ to) & b || why[i].length()) act += (act.length() ? "; " : "") + s_guardWhy[i];
          }
        }
        // logic TẠI BIÊN đã hành động (có mạng hay không): ghi nhật ký board (kiểm chứng sau) + gửi trạng thái lên cloud ngay
        if (act.length()) evLog("logic_act", act + (cloudLinkOk() ? String("") : String(" (đang mất mạng)")));
        if (to != from) cloudExpedite();
      }
    }
  }

  // ---- PHẦN LUÔN CHẠY (có mạng hay không): mất điều kiện / chạy quá lâu → tự TẮT
  {
    uint8_t di = ioDi(), on = ioDo(), off = 0;
    String why[8];
    {
      OLock l;
      s_fieldOk = fieldOk;
      for (int i = 0; i < 8; i++) {
        if (!(on & (1 << i)) || !pol[i].set) continue;
        if (pol[i].needHold && (!diCondsOk(pol[i], di) || !((fieldOk >> i) & 1))) { off |= 1 << i; why[i] = "mất điều kiện (" + failedCond(i, pol[i], di) + ") → tự tắt"; }
        else if (pol[i].maxOnSec) {
          uint32_t last = ioDoLastChange(i);
          // so sánh CÓ DẤU: hẹn giờ vừa bật DO trong CHÍNH nhịp này thì last > now (now lấy đầu nhịp) — trừ không dấu tràn thành số rất lớn
          // → tự tắt ngay (lỗi thật thấy trên board mcu-0.4.4-dev: bật 01:39:00, "chạy quá 30 s" cũng 01:39:00)
          if (last && (int32_t)(now - last) >= (int32_t)(pol[i].maxOnSec * 1000UL)) { off |= 1 << i; why[i] = "chạy quá " + String(pol[i].maxOnSec) + " s → tự tắt"; }
        }
      }
    }
    if (off) {
      bool done = false; uint8_t from = 0, to = 0;
      {
        IoLock io;
        from = ioDo(); to = from & ~off;
        if (to != from && !ioDoWaitMs(to)) done = ioSetDo(to);   // chưa đủ thời gian tối thiểu bật/tắt: thử lại vòng sau
      }
      if (done) {
        String act;
        {
          OLock l;
          for (int i = 0; i < 8; i++) if ((from ^ to) & (1 << i)) { s_guardWhy[i] = "DO" + String(i + 1) + ": " + why[i]; logf("Chương trình logic: %s", s_guardWhy[i].c_str()); act += (act.length() ? "; " : "") + s_guardWhy[i]; }
        }
        evLog("logic_act", act + (cloudLinkOk() ? String("") : String(" (đang mất mạng)")));
        cloudExpedite();
      }
    }
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
      bool any = false; for (auto& r : s_rt) any |= r.active; for (auto& f : s_fo) any |= f.rt.active;
      if (any) logf("Có mạng lại — dừng logic khi mất mạng, DO giữ trạng thái hiện tại (0x%02X)", ioDo());
      for (auto& r : s_rt) r = Rt();
      for (auto& f : s_fo) f.rt = Rt();
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
      case OMode::Follow:
        if (p.di) { on = (((ioDi() >> (p.di - 1)) & 1) != 0) != p.invert; r.note = "DI" + String(p.di) + (on != p.invert ? " có" : " không"); }
        else { on = folOn[i] != p.invert; r.note = p.field + (folOn[i] ? " = 1" : " = 0 / mất số liệu"); }
        break;
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
  for (auto& sn : fs) {
    FOut* f = fout(sn.key);
    if (!f || lease) continue;
    const Pol& p = sn.p; Rt& r = f->rt;
    if (p.mode == OMode::Hold) { r.note = ""; continue; }
    if (!r.active) {
      if (!test && downMs < p.delaySec * 1000UL) { r.note = "chờ " + String((p.delaySec * 1000UL - downMs + 999) / 1000) + " s"; continue; }
      r.active = true; r.since = now; r.thr = fstate(sn.key) > 0;
      logf("Mất mạng %lu s — %s chạy theo: %s", (unsigned long)(downMs / 1000), sn.key.c_str(), describe(p).c_str());
    }
    if (r.manual) continue;
    bool on = false;
    switch (p.mode) {
      case OMode::Off: on = false; r.note = ""; break;
      case OMode::On: on = true; r.note = ""; break;
      case OMode::Schedule:
        if (!timeTrusted()) { on = false; r.note = "không có giờ tin được → tắt"; }
        else { on = inWindow(localMin, p.fromMin, p.toMin); r.note = String(on ? "trong" : "ngoài") + " khung giờ (" + fmtHm(localMin) + ")"; }
        break;
      case OMode::Follow: on = sn.folOn != p.invert; r.note = (p.di ? "DI" + String(p.di) : p.field) + (sn.folOn ? " = 1" : " = 0"); break;
      case OMode::Threshold:
        if (!sn.valOk) { r.thr = false; on = false; r.note = "mất số liệu → tắt"; break; }
        if (p.on < p.off) { if (sn.val <= p.on) r.thr = true; else if (sn.val >= p.off) r.thr = false; }
        else { if (sn.val >= p.on) r.thr = true; else if (sn.val <= p.off) r.thr = false; }
        on = r.thr; r.note = "giá trị " + String(sn.val, 2);
        break;
      case OMode::Cycle: {
        uint32_t per = p.onSec + p.offSec, ph = ((now - r.since) / 1000) % per;
        on = ph < p.onSec; r.note = String(on ? "đang chạy" : "đang nghỉ") + " (" + String(on ? p.onSec - ph : per - ph) + " s nữa đổi)";
        break;
      }
      default: break;
    }
    r.want = on;
    if (fstate(sn.key) < 0 && !on) r.note += " · không rõ trạng thái thiết bị — vẫn gửi lệnh tắt";
    fwant(*f, on ? 1 : 0, String("mất mạng: ") + kModes[(int)p.mode], now);
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
      String why;
      if (offlineGuard(next, m, why).length()) { extra[i] = " · bị chặn: " + why.substring(why.indexOf(':') + 2); continue; }
      next = m;
    }
    if (next != cur) {
      if (ioSetDo(next)) { logf("Logic mất mạng: DO 0x%02X → 0x%02X", cur, next); cloudExpedite(); }
      else logf("Logic mất mạng: ghi DO 0x%02X lỗi", next);
    }
  }
  OLock l;
  for (int i = 0; i < 8; i++) if (extra[i].length()) s_rt[i].note += extra[i];
}
