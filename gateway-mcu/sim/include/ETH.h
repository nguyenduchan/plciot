#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// Ethernet giả: "cắm cáp" ngay khi begin(); IP = IP LAN thật của PC (để GatewayApp máy khác cũng nối được).
enum arduino_event_id_t { ARDUINO_EVENT_ETH_START, ARDUINO_EVENT_ETH_CONNECTED, ARDUINO_EVENT_ETH_GOT_IP, ARDUINO_EVENT_ETH_LOST_IP, ARDUINO_EVENT_ETH_DISCONNECTED, ARDUINO_EVENT_OTHER };
struct arduino_event_info_t {};
typedef void (*NetEventCb)(arduino_event_id_t, arduino_event_info_t);
struct NetworkClass { NetEventCb cb = nullptr; void onEvent(NetEventCb f) { cb = f; } };
extern NetworkClass Network;
#define ETH_PHY_W5500 1
#define SPI2_HOST 1
class EthClass {
 public:
  bool begin(int, int, int, int, int, int, int, int, int);
  IPAddress localIP();
  String macAddress();
  void setHostname(const char*) {}
};
extern EthClass ETH;
