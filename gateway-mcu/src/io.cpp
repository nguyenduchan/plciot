// I/O trên board: DI1..DI8 (GPIO), DO1..DO8 (TCA9554 qua I2C), LED RGB, còi, nút BOOT.
#include "gw.h"
#include "board.h"
#include <Wire.h>

namespace {
uint8_t s_do = 0;          // trạng thái logic của DO (bit n = DOn+1 bật)
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
  for (;;) { diStep(millis()); delay(2); }
}

bool tcaWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(TCA9554_ADDR); Wire.write(reg); Wire.write(v);
  return Wire.endTransmission() == 0;
}
}

void ioBegin() {
  for (int p : DI_PINS) pinMode(p, INPUT);
  diStep(millis());                                     // mẫu đầu tiên làm trạng thái ban đầu
  xTaskCreatePinnedToCore(diTask, "di", 3072, nullptr, 2, nullptr, 0);
  pinMode(PIN_BOOT, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  Wire.begin(I2C_SDA, I2C_SCL, 100000);
  // tắt mọi đầu ra trước khi chuyển chân sang chế độ ra (không bật nhầm tải lúc khởi động)
  s_tca = tcaWrite(0x01, DO_ACTIVE_HIGH ? 0x00 : 0xFF) && tcaWrite(0x03, 0x00);
  if (!s_tca) logf("Không thấy TCA9554 (0x%02X) trên I2C SDA%d/SCL%d — DO không dùng được", TCA9554_ADDR, I2C_SDA, I2C_SCL);
  ioLed(0, 0, 16);
}

uint8_t ioDi() { return s_diState; }
uint32_t ioDiCount(int ch) { return ch >= 0 && ch < 8 ? s_diCount[ch] : 0; }
void ioDiCountSet(int ch, uint32_t v) { if (ch >= 0 && ch < 8) s_diCount[ch] = v; }

uint8_t ioDo() { return s_do; }

bool ioSetDo(uint8_t mask) {
  if (!s_tca) return false;
  if (!tcaWrite(0x01, DO_ACTIVE_HIGH ? mask : (uint8_t)~mask)) return false;
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
