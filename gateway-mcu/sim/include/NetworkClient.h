#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
#include <memory>
// TCP client (Winsock) — Modbus TCP tới PLC, kết nối HTTPS vào board (NetworkServer::accept).
// Socket dùng chung giữa các bản sao (như NetworkClient của Arduino-ESP32): bản sao bị huỷ không đóng kết nối của bản kia.
class NetworkClient {
 public:
  NetworkClient() {}
  explicit NetworkClient(SOCKET s);
  int connect(const char* host, int port, int timeoutMs = 3000);
  bool connected();
  void stop();
  void setNoDelay(bool);
  int available();
  int read();
  int read(uint8_t* buf, size_t n);
  size_t write(const uint8_t* p, size_t n);
  IPAddress remoteIP() const;
  explicit operator bool() const { return h_ && h_->s != INVALID_SOCKET; }
 private:
  struct Holder { SOCKET s = INVALID_SOCKET; ~Holder() { if (s != INVALID_SOCKET) closesocket(s); } };
  std::shared_ptr<Holder> h_;
  SOCKET sock() const { return h_ ? h_->s : INVALID_SOCKET; }
};
