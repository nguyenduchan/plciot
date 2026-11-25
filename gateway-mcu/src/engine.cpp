// Đọc theo chu kỳ PollMs và ghi lệnh — cùng quy tắc với gateway PC (ScadaCore + PackDriverPool + PackCodec):
//   giá trị = giải mã(kiểu, thứ tự word, word từ D) / Scale; field của PLC lỗi bị bỏ khỏi gói (không gửi giá trị cũ);
//   ghi: kiểm Min/Max (đơn vị kỹ thuật), field chỉ đọc bị từ chối, D = v × Scale mã hoá theo kiểu.
#include "gw.h"
#include <math.h>
#include <algorithm>
#include <atomic>

bool g_running = true;
String g_status = "no_devices";

namespace {
std::map<String, double> s_values;   // "child.field" → giá trị
TaskHandle_t s_task = nullptr;
std::atomic<uint32_t> s_seq{0};   // tăng ở luồng đọc, đọc ở loop() (cloud)

double decode(const uint16_t* w0, DType t, bool swap) {
  uint16_t w[4]; int n = t == DType::Float64 ? 4 : (t == DType::UInt32 || t == DType::Int32 || t == DType::Float32) ? 2 : 1;
  for (int i = 0; i < n; i++) w[i] = swap && n > 1 ? w0[n - 1 - i] : w0[i];
  switch (t) {
    case DType::UInt16: case DType::Bool: return w[0];
    case DType::Int16: return (int16_t)w[0];
    case DType::UInt32: return (double)(((uint32_t)w[0] << 16) | w[1]);
    case DType::Int32: return (double)(int32_t)(((uint32_t)w[0] << 16) | w[1]);
    case DType::Float32: { uint32_t u = ((uint32_t)w[0] << 16) | w[1]; float f; memcpy(&f, &u, 4); return isfinite(f) ? f : 0; }
    default: { uint64_t u = ((uint64_t)w[0] << 48) | ((uint64_t)w[1] << 32) | ((uint64_t)w[2] << 16) | w[3]; double d; memcpy(&d, &u, 8); return isfinite(d) ? d : 0; }
  }
}

/// Mã hoá giá trị thô (đã nhân hệ số). false = ngoài khoảng của kiểu số nguyên.
bool encode(double raw, DType t, bool swap, uint16_t* w, int& n) {
  auto R = [](double x, double lo, double hi, double& out) { out = round(x); return !isnan(out) && out >= lo && out <= hi; };
  double r;
  switch (t) {
    case DType::UInt16: if (!R(raw, 0, 65535, r)) return false; w[0] = (uint16_t)r; n = 1; break;
    case DType::Int16: if (!R(raw, -32768, 32767, r)) return false; w[0] = (uint16_t)(int16_t)r; n = 1; break;
    case DType::Bool: w[0] = raw != 0 ? 1 : 0; n = 1; break;
    case DType::UInt32: { if (!R(raw, 0, 4294967295.0, r)) return false; uint32_t u = (uint32_t)r; w[0] = u >> 16; w[1] = u; n = 2; break; }
    case DType::Int32: { if (!R(raw, -2147483648.0, 2147483647.0, r)) return false; uint32_t u = (uint32_t)(int32_t)r; w[0] = u >> 16; w[1] = u; n = 2; break; }
    case DType::Float32: { float f = (float)raw; uint32_t u; memcpy(&u, &f, 4); w[0] = u >> 16; w[1] = u; n = 2; break; }
    default: { uint64_t u; memcpy(&u, &raw, 8); w[0] = u >> 48; w[1] = u >> 32; w[2] = u >> 16; w[3] = u; n = 4; break; }
  }
  if (swap && n > 1) std::reverse(w, w + n);
  return true;
}

String keyOf(const Field& f) { return f.protocol + "|" + String(f.unit); }

/// Một chu kỳ đọc: gom field cùng PLC (giao thức + unit), cách nhau ≤ 8 word, tối đa 100 word/lần.
/// Khoá bus theo TỪNG giao dịch (không giữ cả vòng): lệnh ghi chen vào giữa hai lần đọc, không phải chờ hết vòng có PLC chậm/mất.
void pollOnce() {
  std::vector<Field> fields;
  { Lock l; fields = g_cfg.pack; }   // bản sao: trao đổi với PLC mà không giữ khoá chung
  std::vector<const Field*> rd;
  for (auto& f : fields) if (f.enabled && f.access != Access::Write && (f.proto == Proto::ModbusRtu || f.proto == Proto::ModbusTcp) && (!leaseActive() || f.localIo())) rd.push_back(&f);   // chế độ gateway: PC lo thiết bị ngoài, board chỉ đọc I/O của chính nó
  if (rd.empty()) { Lock l; s_values.clear(); g_status = fields.empty() ? "no_devices" : "online"; s_seq++; return; }
  std::sort(rd.begin(), rd.end(), [](const Field* a, const Field* b) { String ka = keyOf(*a), kb = keyOf(*b); return ka != kb ? ka < kb : a->addr < b->addr; });
  int okReads = 0, badReads = 0;
  std::map<String, double> next;
  size_t i = 0;
  while (i < rd.size()) {
    size_t j = i; int start = rd[i]->addr, end = rd[i]->addr + rd[i]->words();
    while (j + 1 < rd.size() && keyOf(*rd[j + 1]) == keyOf(*rd[i]) && rd[j + 1]->addr - end <= 8 && max(end, rd[j + 1]->addr + rd[j + 1]->words()) - start <= 100) {
      j++; end = max(end, rd[j]->addr + rd[j]->words());
    }
    uint16_t buf[100]; String err;
    wdtFeed(WD_POLL);
    bool ok;
    { BusLockIf bus(!rd[i]->localIo()); ok = mbRead(*rd[i], start, end - start, buf, err); }
    if (ok) {
      okReads++;
      for (size_t k = i; k <= j; k++) {
        const Field& f = *rd[k];
        next[f.child + "." + f.field] = decode(buf + (f.addr - start), f.type, f.swap) / (f.scale > 0 ? f.scale : 1);
      }
    } else {
      badReads++;
      logf("Đọc %s unit %d D%d..%d lỗi: %s", rd[i]->protocol.c_str(), rd[i]->unit, start, end - 1, err.c_str());
    }
    i = j + 1;
  }
  Lock l;
  s_values.swap(next);
  g_status = okReads > 0 ? "online" : "plc_fault";   // một PLC lỗi (PLC khác vẫn đọc được) vẫn báo online; field của nó vắng khỏi gói
  (void)badReads;
  s_seq++;
}

void task(void*) {
  for (;;) {
    wdtArm(WD_POLL, (uint32_t)max(0, g_cfg.pollMs) + 30000);   // một giao dịch Modbus tối đa vài giây (TCP connect 2 s) + chờ PollMs
    uint32_t t0 = millis();
    if (g_running && !g_locked) pollOnce();   // thiết bị bị khoá (báo mất): không đọc PLC
    int wait = max(20, g_cfg.pollMs - (int)(millis() - t0));
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait));   // lệnh ghi xong → đánh thức đọc ngay
  }
}
}  // namespace

void engineBegin() { xTaskCreatePinnedToCore(task, "poll", 8192, nullptr, 1, &s_task, 1); }

void engineRestart() {
  { Lock l; s_values.clear(); }
  modbusReconfigure();
  if (s_task) xTaskNotifyGive(s_task);
}

uint32_t engineSeq() { return s_seq; }

String engineWrite(const String& child, const String& key, double v, bool byWire) {
  Field copy; bool found = false;
  {
    Lock l;
    for (auto& p : g_cfg.pack) {
      const String& k = byWire ? p.wire : p.field;
      if (k.equalsIgnoreCase(key) && (child.length() == 0 || p.child.equalsIgnoreCase(child))) { copy = p; found = true; break; }
    }
  }
  if (g_locked) return "device_locked";
  if (!found) return "unknown_key";
  const Field* f = &copy;
  if ((f->hasMin && v < f->min) || (f->hasMax && v > f->max)) { logf("Từ chối %s.%s = %g: ngoài khoảng", f->child.c_str(), f->field.c_str(), v); return "value_out_of_range"; }
  if (f->access == Access::Read) return "read_only";
  if (!f->enabled) return "device_paused";
  uint16_t w[4]; int n = 0;
  if (!encode(v * f->scale, f->type, f->swap, w, n)) return "bad_value";
  String err;
  bool ok;
  { BusLockIf bus(!f->localIo()); ok = mbWrite(*f, f->addr, w, n, err); }   // DO trên board: không chờ vòng đọc PLC
  if (!ok) { logf("Ghi %s.%s lỗi: %s", f->child.c_str(), f->field.c_str(), err.c_str()); return err == "toggle_too_fast" ? err : "plc_error"; }
  logf("Điều khiển: %s.%s = %g → D%d", f->child.c_str(), f->field.c_str(), v, f->addr);
  if (s_task) xTaskNotifyGive(s_task);
  return "";
}

void engineValues(JsonObject out) {
  Lock l;
  for (auto& kv : s_values) out[kv.first] = kv.second;
}

String engineTelemetry() {
  Lock l;
  if (s_values.empty()) return "";
  JsonDocument d;
  d["schema"] = 2;
  JsonObject dd = d["d"].to<JsonObject>();
  for (auto& f : g_cfg.pack) {
    auto it = s_values.find(f.child + "." + f.field);
    if (it == s_values.end()) continue;
    JsonObject c = dd[f.child].is<JsonObject>() ? dd[f.child].as<JsonObject>() : dd[f.child].to<JsonObject>();
    c[f.wire] = it->second;
  }
  String s; serializeJson(d, s);
  return s;
}
