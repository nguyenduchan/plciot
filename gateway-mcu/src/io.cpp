// I/O trên board: DI1..DI8 (GPIO), DO1..DO8 (TCA9554 qua I2C), LED RGB, còi, nút BOOT.
#include "gw.h"
#include "board.h"
#include <Wire.h>

namespace {
uint8_t s_do = 0;          // trạng thái logic của DO (bit n = DOn+1 bật)
bool s_tca = false;
uint32_t s_btnDown = 0;
bool s_btnWas = false, s_resetArmed = false;

bool tcaWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(TCA9554_ADDR); Wire.write(reg); Wire.write(v);
  return Wire.endTransmission() == 0;
}
}

void ioBegin() {
  for (int p : DI_PINS) pinMode(p, INPUT);
  pinMode(PIN_BOOT, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  Wire.begin(I2C_SDA, I2C_SCL, 100000);
  // tắt mọi đầu ra trước khi chuyển chân sang chế độ ra (không bật nhầm tải lúc khởi động)
  s_tca = tcaWrite(0x01, DO_ACTIVE_HIGH ? 0x00 : 0xFF) && tcaWrite(0x03, 0x00);
  if (!s_tca) logf("Không thấy TCA9554 (0x%02X) trên I2C SDA%d/SCL%d — DO không dùng được", TCA9554_ADDR, I2C_SDA, I2C_SCL);
  ioLed(0, 0, 16);
}

uint8_t ioDi() {
  uint8_t m = 0;
  for (int i = 0; i < 8; i++) { bool lvl = digitalRead(DI_PINS[i]); if (DI_ACTIVE_LOW ? !lvl : lvl) m |= 1 << i; }
  return m;
}

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
      apiOpenWindow(10 * 60 * 1000UL);
      ioBeep(80);
    }
  }
  s_btnWas = down;
}
