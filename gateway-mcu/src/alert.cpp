// Cảnh báo ngưỡng low/high TÍNH TẠI GATEWAY — bản C++ của scada/src/Plciot.Scada.Core/AlertEngine.cs:
// so từng giá trị telemetry với ngưỡng người dùng đặt; khi CHUYỂN trạng thái (ok → low/high) phát lên <base>/alert
//   {"schema":1,"k":"tank1.level","lv":"high","v":95.2,"txt":"Bồn nước: Mức nước vượt ngưỡng cao (95.2 %)","ts":…}
// Mỗi mức của cùng một field báo lại sau tối thiểu 5 phút.
#include "gw.h"
#include <math.h>

namespace {
const uint32_t kCooldownMs = 300000;
std::map<String, String> s_state;      // "child.key" → ok | low | high
std::map<String, uint32_t> s_last;     // "child.key/level" → millis
}

void alertEvaluate(const String& telemetry, std::vector<String>& fired) {
  std::vector<Field> pack;
  { Lock l; pack = g_cfg.pack; }
  JsonDocument d;
  if (deserializeJson(d, telemetry)) return;
  JsonObjectConst dd = d["d"];
  uint32_t now = millis();
  for (auto& f : pack) {
    JsonVariantConst v = dd[f.child][f.wire];
    if (!v.is<double>()) continue;
    FieldLook lim = fieldLook(f);
    if (!lim.hasLow && !lim.hasHigh) continue;
    double x = v.as<double>();
    String path = f.child + "." + f.wire;
    String next = lim.hasHigh && x > lim.high ? "high" : lim.hasLow && x < lim.low ? "low" : "ok";
    String was = s_state.count(path) ? s_state[path] : "ok";
    s_state[path] = next;
    if (next == "ok" || next == was) continue;
    String key = path + "/" + next;
    if (s_last.count(key) && now - s_last[key] < kCooldownMs) continue;
    s_last[key] = now;
    char num[24]; snprintf(num, sizeof num, "%g", round(x * 10) / 10);
    String txt = lim.devTitle + ": " + lim.label + (next == "high" ? " vượt ngưỡng cao (" : " xuống dưới ngưỡng thấp (") + num + (lim.unit.length() ? " " + lim.unit : "") + ")";
    JsonDocument a;
    a["schema"] = 1; a["k"] = path; a["lv"] = next; a["v"] = round(x * 1000) / 1000; a["txt"] = txt; a["ts"] = nowMs();
    String s; serializeJson(a, s);
    fired.push_back(s);
  }
}
