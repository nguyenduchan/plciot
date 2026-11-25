// Modbus master: RTU qua RS485 trên board (UART1, RTS đảo hướng tự động) và TCP qua Ethernet.
// Chỉ dùng FC03 (đọc holding) + FC06 (ghi 1 word) / FC16 (ghi nhiều word) — giống driver Modbus của gateway PC.
// Unit ID 0 trên Modbus RTU = I/O của chính board (xem gw.h), không ra bus.
#include "gw.h"
#include "board.h"
#include <NetworkClient.h>
#include <driver/uart.h>

namespace {
NetworkClient s_tcp;
String s_tcpHost; int s_tcpPort = 0;
uint16_t s_tid = 0;
int s_baud = 0; String s_parity;

uint16_t crc16(const uint8_t* p, size_t n) {
  uint16_t c = 0xFFFF;
  while (n--) { c ^= *p++; for (int i = 0; i < 8; i++) c = (c & 1) ? (c >> 1) ^ 0xA001 : c >> 1; }
  return c;
}

const char* exName(uint8_t e) {
  switch (e) { case 1: return "illegal_function"; case 2: return "illegal_address"; case 3: return "illegal_value"; case 4: return "slave_failure"; default: return "modbus_exception"; }
}

// ---------------------------------------------------------------- RTU
bool rtuTransact(const uint8_t* req, size_t n, uint8_t* resp, size_t want, String& err) {
  if (!g_cfg.rtu.has) { err = "no_rtu_connection"; return false; }
  uint8_t frame[260]; memcpy(frame, req, n);
  uint16_t c = crc16(frame, n); frame[n] = c & 0xFF; frame[n + 1] = c >> 8;
  while (Serial1.available()) Serial1.read();
  Serial1.write(frame, n + 2); Serial1.flush();
  // chờ đủ khung trả lời (hoặc khung lỗi 5 byte); thời gian chờ theo baud
  uint32_t t0 = millis(), timeout = 150 + (uint32_t)(want * 11000UL / max(1200, s_baud));
  size_t got = 0;
  while (millis() - t0 < timeout) {
    while (Serial1.available() && got < want) resp[got++] = Serial1.read();
    if (got >= 5 && (resp[1] & 0x80)) { want = 5; }
    if (got >= want) break;
    delay(1);
  }
  if (got < want) { err = got == 0 ? "timeout" : "short_frame"; return false; }
  if (resp[0] != req[0]) { err = "wrong_unit"; return false; }
  uint16_t rc = crc16(resp, want - 2);
  if (resp[want - 2] != (rc & 0xFF) || resp[want - 1] != (rc >> 8)) { err = "bad_crc"; return false; }
  if (resp[1] & 0x80) { err = exName(resp[2]); return false; }
  return true;
}

// ---------------------------------------------------------------- TCP
bool tcpTransact(uint8_t unit, const uint8_t* pdu, size_t n, uint8_t* resp, size_t wantPdu, String& err) {
  if (!g_cfg.tcp.has) { err = "no_tcp_connection"; return false; }
  if (s_tcpHost != g_cfg.tcp.host || s_tcpPort != g_cfg.tcp.port) { s_tcp.stop(); s_tcpHost = g_cfg.tcp.host; s_tcpPort = g_cfg.tcp.port; }
  if (!s_tcp.connected()) {
    s_tcp.stop();
    if (!s_tcp.connect(s_tcpHost.c_str(), s_tcpPort, 2000)) { err = "connect_failed"; return false; }
    s_tcp.setNoDelay(true);
  }
  uint8_t hdr[7]; uint16_t tid = ++s_tid;
  hdr[0] = tid >> 8; hdr[1] = tid & 0xFF; hdr[2] = 0; hdr[3] = 0; hdr[4] = (n + 1) >> 8; hdr[5] = (n + 1) & 0xFF; hdr[6] = unit;
  while (s_tcp.available()) s_tcp.read();
  s_tcp.write(hdr, 7); s_tcp.write(pdu, n);
  uint8_t rh[7]; size_t got = 0; uint32_t t0 = millis();
  while (got < 7 && millis() - t0 < 2000) { if (s_tcp.available()) rh[got++] = s_tcp.read(); else delay(1); }
  if (got < 7) { s_tcp.stop(); err = "timeout"; return false; }
  size_t len = ((rh[4] << 8) | rh[5]) - 1;
  if (len > 256 || ((rh[0] << 8) | rh[1]) != tid) { s_tcp.stop(); err = "bad_frame"; return false; }
  got = 0;
  while (got < len && millis() - t0 < 2000) { if (s_tcp.available()) resp[got++] = s_tcp.read(); else delay(1); }
  if (got < len) { s_tcp.stop(); err = "timeout"; return false; }
  if (resp[0] & 0x80) { err = exName(resp[1]); return false; }
  if (len < wantPdu) { err = "short_frame"; return false; }
  return true;
}

// ---------------------------------------------------------------- I/O trên board (Unit 0)
bool localRead(int addr, int count, uint16_t* out, String& err) {
  uint8_t di = ioDi(), dout = ioDo();
  for (int i = 0; i < count; i++) {
    int a = addr + i;
    if (a == 0) out[i] = di;
    else if (a == 1) out[i] = dout;
    else if (a >= 10 && a <= 17) out[i] = (di >> (a - 10)) & 1;
    else if (a >= 20 && a <= 27) out[i] = (dout >> (a - 20)) & 1;
    else if (a >= 30 && a <= 37) out[i] = ioDiCount(a - 30) & 0xFFFF;                 // bộ đếm cạnh lên, 16 bit
    else if (a >= 40 && a <= 55) { uint32_t c = ioDiCount((a - 40) / 2); out[i] = ((a - 40) & 1) ? (c & 0xFFFF) : (c >> 16); }   // 32 bit, word cao trước
    else out[i] = 0;
  }
  return true;
}

bool localWrite(int addr, const uint16_t* w, int count, String& err) {
  IoLock io;   // đọc-sửa-ghi DO nguyên khối: hai nguồn ghi (cloud, API LAN, slave) không đè nhau
  uint8_t m = ioDo();
  for (int i = 0; i < count; i++) {
    int a = addr + i;
    if (a == 1) m = w[i] & 0xFF;
    else if (a >= 20 && a <= 27) m = w[i] ? (m | (1 << (a - 20))) : (m & ~(1 << (a - 20)));
    else if (a >= 30 && a <= 37) ioDiCountSet(a - 30, w[i]);                           // ghi = đặt lại bộ đếm
    else if (a >= 40 && a <= 55) { int ch = (a - 40) / 2; uint32_t c = ioDiCount(ch); ioDiCountSet(ch, ((a - 40) & 1) ? ((c & 0xFFFF0000u) | w[i]) : ((c & 0xFFFFu) | ((uint32_t)w[i] << 16))); }
    else { err = "illegal_address"; return false; }   // DI chỉ đọc; ô khác không có
  }
  if (m != ioDo()) {
    uint32_t wait = ioDoWaitMs(m);
    if (wait) { err = "toggle_too_fast"; logf("Từ chối đổi DO quá nhanh (còn %lu ms)", (unsigned long)wait); return false; }   // bảo vệ tiếp điểm relay
    if (!ioSetDo(m)) { err = "do_unavailable"; return false; }
  }
  return true;
}
}  // namespace

void modbusBegin() { modbusReconfigure(); }

void modbusReconfigure() {
  BusLock b; Lock l;
  if (!g_cfg.rtu.has) return;
  int baud = g_cfg.rtu.port > 0 ? g_cfg.rtu.port : 19200;
  if (baud == s_baud && g_cfg.rtu.parity == s_parity) return;
  uint32_t mode = g_cfg.rtu.parity == "None" ? SERIAL_8N1 : g_cfg.rtu.parity == "Odd" ? SERIAL_8O1 : SERIAL_8E1;
  Serial1.end();
  Serial1.begin(baud, mode, RS485_RX, RS485_TX);
  Serial1.setPins(RS485_RX, RS485_TX, -1, RS485_RTS);
  Serial1.setMode(UART_MODE_RS485_HALF_DUPLEX);
  s_baud = baud; s_parity = g_cfg.rtu.parity;
  logf("RS485: %d baud, parity %s", baud, s_parity.c_str());
}

bool mbRead(const Field& f, int addr, int count, uint16_t* out, String& err) {
  if (count < 1 || count > 125) { err = "bad_range"; return false; }
  if (f.localIo()) return localRead(addr, count, out, err);
  uint8_t pdu[5] = {3, (uint8_t)(addr >> 8), (uint8_t)addr, (uint8_t)(count >> 8), (uint8_t)count};
  uint8_t resp[260];
  if (f.proto == Proto::ModbusRtu) {
    uint8_t req[6] = {(uint8_t)f.unit}; memcpy(req + 1, pdu, 5);
    if (!rtuTransact(req, 6, resp, 5 + count * 2, err)) return false;
    for (int i = 0; i < count; i++) out[i] = (resp[3 + i * 2] << 8) | resp[4 + i * 2];
    return true;
  }
  if (f.proto == Proto::ModbusTcp) {
    if (!tcpTransact(f.unit, pdu, 5, resp, 2 + count * 2, err)) return false;
    for (int i = 0; i < count; i++) out[i] = (resp[2 + i * 2] << 8) | resp[3 + i * 2];
    return true;
  }
  err = "unsupported_protocol";
  return false;
}

bool mbWrite(const Field& f, int addr, const uint16_t* w, int count, String& err) {
  if (f.localIo()) return localWrite(addr, w, count, err);
  uint8_t pdu[260]; size_t n;
  if (count == 1) { pdu[0] = 6; pdu[1] = addr >> 8; pdu[2] = addr; pdu[3] = w[0] >> 8; pdu[4] = w[0]; n = 5; }
  else {
    pdu[0] = 16; pdu[1] = addr >> 8; pdu[2] = addr; pdu[3] = count >> 8; pdu[4] = count; pdu[5] = count * 2; n = 6;
    for (int i = 0; i < count; i++) { pdu[n++] = w[i] >> 8; pdu[n++] = w[i]; }
  }
  uint8_t resp[260];
  if (f.proto == Proto::ModbusRtu) {
    uint8_t req[262] = {(uint8_t)f.unit}; memcpy(req + 1, pdu, n);
    return rtuTransact(req, n + 1, resp, 8, err);
  }
  if (f.proto == Proto::ModbusTcp) return tcpTransact(f.unit, pdu, n, resp, 5, err);
  err = "unsupported_protocol";
  return false;
}
