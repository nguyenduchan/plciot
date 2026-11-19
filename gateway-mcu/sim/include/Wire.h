#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
class TwoWire { public: void begin(int, int, uint32_t) {} void beginTransmission(uint8_t) {} void write(uint8_t) {} int endTransmission() { return 0; } };
extern TwoWire Wire;
