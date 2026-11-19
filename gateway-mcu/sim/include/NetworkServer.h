#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <NetworkClient.h>
// TCP server (Winsock) như NetworkServer của Arduino-ESP32: accept() không chặn, trả NetworkClient rỗng khi chưa có ai.
class NetworkServer {
 public:
  explicit NetworkServer(int port) : port_(port) {}
  void begin();
  NetworkClient accept();
 private:
  int port_;
  SOCKET ls_ = INVALID_SOCKET;
};
