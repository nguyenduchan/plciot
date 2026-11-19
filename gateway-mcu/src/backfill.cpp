// Bù dữ liệu offline — cùng quy tắc với GatewayApp (LocalHistoryDb.cs + MainForm.History.cs, docs/PROTOCOL.md "Bù dữ liệu offline"):
//   lúc cloud bật + tem đã có user mà KHÔNG nối được, mỗi LocalHistoryIntervalSec giây ghi một mốc {ts, d} vào flash;
//   nối lại thì gửi bù cũ nhất trước, ~10 bản tin/giây, dạng {"schema":2,"bf":1,"ts":<ms gốc>,"d":{…}}, bỏ mốc quá hạn lưu của gói.
// Board không có SQLite: hàng đợi là 2 file dòng trên LittleFS (bf0 cũ, bf1 mới). Đầy (mỗi file > 1 MB) thì bỏ file cũ nhất.
#include "gw.h"
#include <LittleFS.h>

namespace {
const size_t kFileCap = 1024 * 1024;
const char* F0 = "/bf0.q"; const char* F1 = "/bf1.q"; const char* FPOS = "/bf.pos";
int64_t s_lastStep = 0;
size_t s_pos = 0;            // vị trí đọc trong bf0 (hoặc bf1 khi bf0 đã hết)
size_t s_nextPos = 0;        // vị trí sau gói đang gửi
bool s_posLoaded = false;
int s_unsaved = 0;
String s_file;               // file đang đọc

void loadPos() {
  if (s_posLoaded) return;
  s_posLoaded = true;
  File f = LittleFS.open(FPOS, "r");
  if (f) { s_pos = f.parseInt(); f.close(); }
}
void savePos() { File f = LittleFS.open(FPOS, "w"); if (f) { f.print((unsigned long)s_pos); f.close(); } s_unsaved = 0; }

String dPart(const String& tele) {
  int i = tele.indexOf("\"d\":");
  return i < 0 || !tele.endsWith("}") ? "" : tele.substring(i + 4, tele.length() - 1);
}
}  // namespace

void backfillRecord(const String& tele, bool cloudOk) {
  bool needSync;
  { Lock l; needSync = g_cfg.cloudOn() && g_cfg.sendData && g_cfg.mqttId.length(); }
  if (!needSync || cloudOk || tele.length() == 0 || !timeSynced()) return;
  int64_t step = (int64_t)g_cfg.histIntervalSec * 1000, now = nowMs();
  int64_t slot = now - now % step;
  if (slot == s_lastStep) return;
  s_lastStep = slot;
  String d = dPart(tele);
  if (d.length() == 0) return;
  File f1 = LittleFS.open(F1, "a");
  if (!f1) return;
  size_t size = f1.size();
  f1.printf("%lld\t", (long long)slot); f1.print(d); f1.print('\n'); f1.close();
  if (size > kFileCap) {   // xoay: bỏ mốc cũ nhất (bf0) — giống giới hạn số ngày giữ, nhưng theo dung lượng flash
    bool dropped = LittleFS.exists(F0);
    if (LittleFS.exists(F0)) LittleFS.remove(F0);
    LittleFS.rename(F1, F0);
    loadPos(); s_pos = 0; savePos();
    if (dropped) logf("Hàng đợi gửi bù đầy — bỏ phần dữ liệu offline cũ nhất");
  }
}

bool backfillNext(String& payload) {
  loadPos();
  int64_t oldest = 0;
  { Lock l; if (g_cfg.retentionDays > 0) oldest = nowMs() - (int64_t)g_cfg.retentionDays * 86400000LL; }
  for (int guard = 0; guard < 200; guard++) {
    s_file = LittleFS.exists(F0) ? F0 : F1;
    File f = LittleFS.open(s_file, "r");
    if (!f) return false;
    if (s_pos >= f.size()) {
      f.close();
      LittleFS.remove(s_file); s_pos = 0; savePos();
      if (s_file == F1) return false;      // đã hết cả hai file
      continue;
    }
    f.seek(s_pos);
    String line = f.readStringUntil('\n');
    s_nextPos = f.position(); f.close();
    int tab = line.indexOf('\t');
    long long ts = tab > 0 ? atoll(line.substring(0, tab).c_str()) : 0;
    if (tab <= 0 || (oldest > 0 && ts < oldest)) { s_pos = s_nextPos; continue; }   // hỏng / quá hạn lưu của gói: cloud không nhận → bỏ
    payload = "{\"schema\":2,\"bf\":1,\"ts\":" + String(ts) + ",\"d\":" + line.substring(tab + 1) + "}";
    return true;
  }
  return false;
}

void backfillAck() {
  s_pos = s_nextPos;
  if (++s_unsaved >= 20) savePos();   // không ghi flash mỗi gói; khởi động lại có thể gửi trùng vài mốc — server bỏ mốc trùng ts
}

size_t backfillPending() {
  size_t n = 0;
  if (File f = LittleFS.open(F0, "r")) { n += f.size(); f.close(); }
  if (File f = LittleFS.open(F1, "r")) { n += f.size(); f.close(); }
  return n > s_pos ? n - s_pos : 0;
}
