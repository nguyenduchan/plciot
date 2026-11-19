#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// TCP client (Winsock) — Modbus TCP tới PLC.
class NetworkClient {
 public:
  ~NetworkClient() { stop(); }
  int connect(const char* host, int port, int timeoutMs = 3000);
  bool connected();
  void stop();
  void setNoDelay(bool);
  int available();
  int read();
  size_t write(const uint8_t* p, size_t n);
 private:
  SOCKET s_ = INVALID_SOCKET;
};
