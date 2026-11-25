#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// NVS giả: mỗi khoá một file <SIM_DATA>/nvs-<khoá>.txt
class Preferences {
 public:
  bool begin(const char*, bool) { return true; }
  String getString(const char* key, const char* def);
  size_t putString(const char* key, const String& v);
  bool remove(const char* key);
  bool isKey(const char* key) { return getString(key, "") != ""; }
  void end() {}
};
