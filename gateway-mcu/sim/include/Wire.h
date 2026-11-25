#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// I2C giả: chỉ có TCA9554 (0x20) với 4 thanh ghi — đủ để thử đường ghi DO + đọc lại. Địa chỉ khác (RTC 0x51) không trả lời (NACK).
// SIM_TCA_FAIL=1 (biến môi trường, đọc mỗi lần) → TCA9554 cũng không trả lời: thử LED tím / DoOk=false / task io dò lại.
class TwoWire {
 public:
  void begin(int, int, uint32_t) {}
  void end() {}
  void setTimeOut(uint16_t) {}
  void beginTransmission(uint8_t a) { addr_ = a; n_ = 0; }
  void write(uint8_t v) { if (n_ < 8) buf_[n_++] = v; }
  int endTransmission(bool = true) {
    if (!present(addr_)) return 2;
    if (n_ >= 1) reg_ = buf_[0] & 3;
    if (n_ >= 2) regs_[reg_] = buf_[1];
    return 0;
  }
  int requestFrom(int a, int n) { if (!present((uint8_t)a)) return 0; rd_ = n; return n; }
  int available() { return rd_; }
  int read() { if (rd_ <= 0) return -1; rd_--; return reg_ == 0 ? 0 : regs_[reg_]; }
 private:
  static bool present(uint8_t a) { const char* f = getenv("SIM_TCA_FAIL"); return a == 0x20 && !(f && *f == '1'); }
  uint8_t addr_ = 0, buf_[8] = {0}, n_ = 0, reg_ = 0, regs_[4] = {0, 0xFF, 0, 0xFF};
  int rd_ = 0;
};
extern TwoWire Wire;
