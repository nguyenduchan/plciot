#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// UDP (Winsock) — tìm thiết bị (cổng 8751), dùng chung cổng với GatewayApp trên cùng máy (SO_REUSEADDR).
class NetworkUDP {
 public:
  bool begin(int port);
  int parsePacket();
  int read(char* buf, int n);
  IPAddress remoteIP() const;
  uint16_t remotePort() const { return ntohs(from_.sin_port); }
  int beginPacket(IPAddress, uint16_t) { out_.clear(); return 1; }
  size_t print(const String& s) { out_ += s.s; return s.length(); }
  int endPacket();
 private:
  SOCKET s_ = INVALID_SOCKET;
  sockaddr_in from_ = {};
  char buf_[1500]; int len_ = 0;
  std::string out_;
};
