#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// Update (OTA) giả: ghi firmware nhận được ra <SIM_DATA>/ota-new.bin — để thử luồng duyệt + chữ ký + SHA-256 mà không cần board.
#define U_FLASH 0
class UpdateClass {
 public:
  bool begin(size_t size, int = U_FLASH);
  size_t write(uint8_t* p, size_t n);
  bool end(bool evenIfRemaining = false);
  void abort();
  const char* errorString() { return err_; }
 private:
  FILE* f_ = nullptr; size_t want_ = 0, got_ = 0; const char* err_ = "";
};
extern UpdateClass Update;
