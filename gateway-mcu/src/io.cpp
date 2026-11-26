// I/O trên board: DI1..DI8 (GPIO), DO1..DO8 (TCA9554 qua I2C), LED RGB, còi, nút BOOT.
#include "gw.h"
#include "board.h"
#include <Wire.h>

namespace {
uint8_t s_do = 0;          // trạng thái logic của DO (bit n = DOn+1 bật)
// Thời gian tối thiểu giữa hai lần đổi trạng thái DO (bảo vệ tiếp điểm). s_doEver: kênh đã đổi ít nhất một lần từ lúc khởi động
// (lần đổi ĐẦU sau khởi động luôn được — mọi DO đều tắt lúc khởi động nên không có chuyện bật/tắt dồn dập).
uint32_t s_doMinCfg[8] = {0}, s_doMinLease[8] = {0}, s_doLast[8] = {0};
uint8_t s_doEver = 0;
uint32_t doMin(int ch) { uint32_t a = s_doMinCfg[ch], b = leaseActive() ? s_doMinLease[ch] : 0; return a > b ? a : b; }
bool s_tca = false;
uint32_t s_btnDown = 0;
bool s_btnWas = false, s_resetArmed = false;

// ---- DI: lấy mẫu nền 2 ms → lọc rung → bộ đếm cạnh lên. Giá trị chính là MỨC đã lọc (tự phục hồi sau mất gói / khởi động lại);
// bộ đếm cạnh dành cho tín hiệu xung (đồng hồ lưu lượng, đếm sản phẩm) — không mất xung dù engine đọc chậm.
// Lọc: một kênh chỉ đổi mức khi mức thô mới giữ ổn định liên tục ≥ diFilterMs (tuỳ chọn "difilter" của kết nối Modbus RTU, mặc định 20 ms; 0 = tắt lọc).
volatile uint8_t s_diState = 0;                    // mức đã lọc (bit n = DIn+1 có tín hiệu)
volatile uint32_t s_diCount[8] = {0};
uint8_t rawDi() {
  uint8_t m = 0;
  for (int i = 0; i < 8; i++) { bool lvl = digitalRead(DI_PINS[i]); if (DI_ACTIVE_LOW ? !lvl : lvl) m |= 1 << i; }
  return m;
}
void diStep(uint32_t now) {
  static bool init = false; static uint8_t cand = 0; static uint32_t since[8] = {0};
  uint8_t raw = rawDi();
  if (!init) { init = true; cand = raw; s_diState = raw; return; }   // trạng thái ban đầu không tính là cạnh
  uint32_t filt = (uint32_t)max(0, g_cfg.rtu.diFilterMs);
  for (int i = 0; i < 8; i++) {
    uint8_t b = 1 << i, rb = raw & b;
    if (rb != (cand & b)) { cand = (cand & ~b) | rb; since[i] = now; }
    if ((s_diState & b) != (cand & b) && (filt == 0 || now - since[i] >= filt)) {
      uint8_t ns = (s_diState & ~b) | (cand & b);
      if (cand & b) s_diCount[i] = s_diCount[i] + 1;
      s_diState = ns;
    }
  }
}
void diTask(void*) {
  wdtArm(WD_DI, 2000);
  for (;;) { wdtFeed(WD_DI); diStep(millis()); delay(2); }
}

// ---- TCA9554 (DO1..DO8). Thanh ghi: 0x01 = output, 0x03 = cấu hình (0 = chân ra). Mọi truy cập giữ IoLock.
// Không tin một lần ghi I2C thành công: đọc lại thanh ghi để chắc chip đang giữ đúng trạng thái (nhiễu, chip bị reset do sụt áp
// sẽ quay về "toàn bộ là input" = DO tắt mà firmware không hay). Task "io" kiểm lại mỗi 500 ms và ghi lại khi lệch.
uint8_t tcaOut(uint8_t mask) { return DO_ACTIVE_HIGH ? mask : (uint8_t)~mask; }

bool tcaWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(TCA9554_ADDR); Wire.write(reg); Wire.write(v);
  return Wire.endTransmission() == 0;
}

bool tcaRead(uint8_t reg, uint8_t& v) {
  Wire.beginTransmission(TCA9554_ADDR); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)TCA9554_ADDR, 1) != 1 || !Wire.available()) return false;
  v = (uint8_t)Wire.read();
  return true;
}

/// Ghi output TRƯỚC rồi mới đặt chân là output (không bật nhầm tải), sau đó đọc lại cả hai thanh ghi.
bool tcaApply(uint8_t mask) {
  uint8_t o = 0, c = 0xFF;
  return tcaWrite(0x01, tcaOut(mask)) && tcaWrite(0x03, 0x00) && tcaRead(0x01, o) && tcaRead(0x03, c) && o == tcaOut(mask) && c == 0x00;
}

void wireStart() {
  Wire.begin(I2C_SDA, I2C_SCL, 100000);
  Wire.setTimeOut(20);   // một thiết bị giữ SCL không làm treo task quá 20 ms
}

/// Gỡ kẹt bus I2C: một slave đang giữ SDA thấp (bị reset giữa chừng một byte) → phát tối đa 9 xung SCL cho nó nhả, rồi STOP.
void i2cRecover() {
#ifndef GW_SIM
  Wire.end();
  pinMode(I2C_SDA, INPUT_PULLUP);
  pinMode(I2C_SCL, OUTPUT_OPEN_DRAIN);
  for (int i = 0; i < 9 && digitalRead(I2C_SDA) == LOW; i++) {
    digitalWrite(I2C_SCL, LOW); delayMicroseconds(5);
    digitalWrite(I2C_SCL, HIGH); delayMicroseconds(5);
  }
  pinMode(I2C_SDA, OUTPUT_OPEN_DRAIN);
  digitalWrite(I2C_SDA, LOW); delayMicroseconds(5);
  digitalWrite(I2C_SCL, HIGH); delayMicroseconds(5);
  digitalWrite(I2C_SDA, HIGH); delayMicroseconds(5);
  pinMode(I2C_SDA, INPUT_PULLUP); pinMode(I2C_SCL, INPUT_PULLUP);
#endif
  wireStart();
}

uint32_t s_tcaFaults = 0;

void tcaSetOk(bool ok) {
  if (ok == s_tca) return;
  s_tca = ok;
  if (ok) logf("TCA9554: DO hoạt động lại (đã ghi lại trạng thái 0x%02X)", s_do);
  else { s_tcaFaults++; logf("TCA9554 không trả lời / thanh ghi lệch — DO KHÔNG tin được (lần %lu)", (unsigned long)s_tcaFaults); }
}

/// Task nền: kiểm thanh ghi TCA9554 mỗi 500 ms, lệch thì ghi lại, mất thì gỡ kẹt bus và dò lại.
void ioTask(void*) {
  wdtArm(WD_IO, 5000);
  for (;;) {
    wdtFeed(WD_IO);
    {
      IoLock l;
      uint8_t o = 0, c = 0xFF;
      bool ok = tcaRead(0x01, o) && tcaRead(0x03, c);
      if (ok && (o != tcaOut(s_do) || c != 0x00)) { logf("TCA9554 lệch (out 0x%02X cfg 0x%02X, cần 0x%02X) — ghi lại", o, c, tcaOut(s_do)); ok = tcaApply(s_do); }
      if (!ok) { i2cRecover(); ok = tcaApply(s_do); }
      tcaSetOk(ok);
    }
    safetyTick();
    offlineTick();
    delay(500);
  }
}
}

SemaphoreHandle_t g_io = xSemaphoreCreateRecursiveMutex();

void ioBegin() {
  for (int p : DI_PINS) pinMode(p, INPUT);
  diStep(millis());                                     // mẫu đầu tiên làm trạng thái ban đầu
  xTaskCreatePinnedToCore(diTask, "di", 3072, nullptr, 2, nullptr, 0);
  pinMode(PIN_BOOT, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  {
    IoLock l;
    wireStart();
    // tắt mọi đầu ra trước khi chuyển chân sang chế độ ra (không bật nhầm tải lúc khởi động); TCA9554 không bị reset theo ESP32
    // nên tới đây DO vẫn giữ trạng thái trước lúc khởi động lại
    s_do = 0;
    s_tca = tcaApply(0);
    if (!s_tca) { i2cRecover(); s_tca = tcaApply(0); }
  }
  if (!s_tca) logf("Không thấy TCA9554 (0x%02X) trên I2C SDA%d/SCL%d — DO không dùng được (task io sẽ dò lại)", TCA9554_ADDR, I2C_SDA, I2C_SCL);
  xTaskCreatePinnedToCore(ioTask, "io", 3072, nullptr, 2, nullptr, 0);
  ioLed(0, 0, 16);
}

uint8_t ioDi() { return s_diState; }
uint32_t ioDiCount(int ch) { return ch >= 0 && ch < 8 ? s_diCount[ch] : 0; }
void ioDiCountSet(int ch, uint32_t v) { if (ch >= 0 && ch < 8) s_diCount[ch] = v; }

uint8_t ioDo() { return s_do; }

void ioDoMinCfg(const uint32_t* ms8) { for (int i = 0; i < 8; i++) s_doMinCfg[i] = ms8[i]; }
void ioDoMinLease(const uint32_t* ms8) { for (int i = 0; i < 8; i++) s_doMinLease[i] = ms8[i]; }

uint32_t ioDoWaitMs(uint8_t mask) {
  uint8_t changed = mask ^ s_do; uint32_t now = millis(), wait = 0;
  for (int i = 0; i < 8; i++) {
    if (!(changed & (1 << i)) || !(s_doEver & (1 << i))) continue;
    uint32_t mn = doMin(i), el = now - s_doLast[i];
    if (mn && el < mn && mn - el > wait) wait = mn - el;
  }
  return wait;
}

bool ioDoOk() { return s_tca; }

uint32_t ioDoLastChange(int ch) { return ch >= 0 && ch < 8 && (s_doEver & (1 << ch)) ? s_doLast[ch] : 0; }

bool ioSetDo(uint8_t mask) {
  IoLock l;
  if (!s_tca) return false;
  if (safeMode() && (mask & ~s_do)) return false;   // chế độ an toàn: chỉ cho TẮT (localWrite báo "safe_mode" trước khi tới đây)
  bool ok = tcaWrite(0x01, tcaOut(mask));
  uint8_t o = 0;
  ok = ok && tcaRead(0x01, o) && o == tcaOut(mask);
  if (!ok) { i2cRecover(); ok = tcaApply(mask); }   // thử lại MỘT lần sau khi gỡ kẹt bus
  if (!ok) { tcaSetOk(false); return false; }        // trạng thái chip không rõ: task io sẽ dò lại và ghi s_do (trạng thái cũ)
  uint8_t changed = mask ^ s_do; uint32_t now = millis();
  for (int i = 0; i < 8; i++) if (changed & (1 << i)) { s_doLast[i] = now; s_doEver |= 1 << i; }
  s_do = mask;
  return true;
}

void ioLed(uint8_t r, uint8_t g, uint8_t b) { rgbLedWrite(PIN_RGB, r, g, b); }

void ioBeep(int ms) { digitalWrite(PIN_BUZZER, HIGH); delay(ms); digitalWrite(PIN_BUZZER, LOW); }

/// Nút BOOT: nhấn ngắn (< 3 s) → mở cho admin đăng nhập 10 phút; giữ 10 s → xoá cấu hình (giữ khoá danh tính và mã kết nối).
void ioLoop() {
  bool down = digitalRead(PIN_BOOT) == LOW;
  uint32_t now = millis();
  if (down && !s_btnWas) { s_btnDown = now; s_resetArmed = false; }
  if (down && !s_resetArmed && now - s_btnDown > 10000) { s_resetArmed = true; ioBeep(600); }
  if (!down && s_btnWas) {
    uint32_t held = now - s_btnDown;
    if (s_resetArmed) {
      logf("Giữ BOOT 10 giây: xoá cấu hình, khởi động lại");
      storeReset();
      delay(200); ESP.restart();
    } else if (held > 30 && held < 3000) {
      apiOpenWindow(SETUP_WINDOW_MS);
      ioBeep(80);
    }
  }
  s_btnWas = down;
}
