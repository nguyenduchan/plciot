#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// Giao diện Client của Arduino (PubSubClient nói chuyện qua đây).
class Client : public Stream {
 public:
  virtual int connect(IPAddress ip, uint16_t port) = 0;
  virtual int connect(const char* host, uint16_t port) = 0;
  size_t write(uint8_t c) override = 0;
  size_t write(const uint8_t* p, size_t n) override = 0;
  int available() override = 0;
  int read() override = 0;
  virtual int read(uint8_t* buf, size_t n) = 0;
  int peek() override = 0;
  virtual void flush() = 0;
  virtual void stop() = 0;
  virtual uint8_t connected() = 0;
  virtual operator bool() = 0;
};
