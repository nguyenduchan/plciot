#pragma once

// MQTT broker. Through the Cloudflare tunnel (TLS, no open ports, works behind any NAT):
//   "wss://plc-mqtt.dieukhientudong.net:443/mqtt"
// Or LAN-only plain MQTT for bench testing: "mqtt://192.168.1.10:1883"
#define MQTT_URI    "wss://plc-mqtt.dieukhientudong.net:443/mqtt"
#define SITE        "factory1"
#define DEVICE      "plc01"
#define MQTT_USER   "gw"
#define MQTT_PASS   "change-me"

// RS485 side: must match the PLC COM port setting in XDPPro (Modbus slave)
#define RS485_BAUD    19200
#define RS485_CONFIG  SERIAL_8E1
#define PIN_RS485_RX  5
#define PIN_RS485_TX  17
#define PIN_RS485_DE  4        // MAX485 DE+RE tied together

#define PLC_UNIT      1        // PLC station number
#define POLL_MS       1000     // Modbus poll period
#define HISTORY_MS    60000    // hourly history block (D100-D150, D199-D248) refresh period
#define HEARTBEAT_MS  10000    // publish at least this often even if nothing changed
#define REG_FIRST     0        // D0
#define REG_COUNT     40       // D0..D39

// Registers the cloud/app may write. Everything else is refused.
static const uint16_t WRITABLE[] = {3, 4, 6, 7, 9};   // D3 mode, D4 manual mask, D6 conveyor run, D7 target, D9 reset count
