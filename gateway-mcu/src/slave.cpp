// Chế độ GATEWAY của board: lease + Modbus TCP slave.
//   Độc lập (mặc định): board tự đọc thiết bị + đẩy MQTTS lên cloud.
//   Gateway: một PC admin giữ LEASE (POST /api/lease qua HTTPS đã xác thực, gia hạn bằng nhịp tim) → board tạm dừng MQTTS và mở Modbus TCP slave
//   (cổng MBS_PORT) CHỈ cho IP của PC đó. Mất nhịp tim quá hạn → đóng slave, MQTTS nối lại — tự về độc lập, không ai phải can thiệp.
// Bản đồ Modbus TCP:
//   Unit 0 : I/O của board. Thanh ghi giữ/nhập (FC03/04, ghi FC06/16): D0 DI gộp · D1 DO gộp · D10..17 DI · D20..27 DO · D30.. bộ đếm (xem modbus.cpp).
//            Coil (FC01 đọc, FC05 ghi): coil n = DO(n+1), n = 0..7.  Discrete input (FC02): n = DI(n+1), n = 0..7.
//   Unit n ≠ 0 : CẦU sang RS485 — board VẪN LÀ MASTER RS485, chuyển FC03/04/06/16 tới slave Unit n (bus có khoá, không đụng vòng đọc).
#include "gw.h"
#include "board.h"
#include <NetworkServer.h>
#include <NetworkClient.h>
#include <ETH.h>

namespace {
NetworkServer s_srv(MBS_PORT);
bool s_started = false, s_wasActive = false;
uint32_t s_until = 0; bool s_has = false; IPAddress s_holder;
NetworkClient s_cli;
uint8_t s_buf[300]; size_t s_n = 0; uint32_t s_lastRx = 0;
const uint32_t kIdleMs = 30000;   // khách im lặng quá lâu → đóng (PC giữ lease sẽ nối lại)

uint8_t exCode(const String& e) {
  if (e == "illegal_address") return 2;
  if (e == "illegal_value" || e == "bad_range") return 3;
  if (e == "timeout" || e == "short_frame" || e == "bad_crc" || e == "wrong_unit" || e == "bad_frame" || e == "connect_failed") return 0x0B;   // thiết bị sau board không trả lời
  if (e == "no_rtu_connection") return 0x0A;
  if (e == "toggle_too_fast") return 6;
  if (e == "safe_mode") return 4;   // Slave Device Failure: board đang ở chế độ an toàn (khởi động lại liên tục)   // Slave Device Busy: DO vừa đổi trạng thái, chưa đủ thời gian tối thiểu
  return 4;
}

Field target(uint8_t unit) { Field f; f.proto = Proto::ModbusRtu; f.unit = unit; return f; }   // unit 0 → I/O board (localIo), còn lại ra RS485

/// Xử lý một PDU; trả độ dài PDU trả lời (đã gồm mã hàm). Lỗi → PDU ngoại lệ.
size_t handle(uint8_t unit, const uint8_t* q, size_t qn, uint8_t* r) {
  auto fail = [&](uint8_t code) { r[0] = q[0] | 0x80; r[1] = code; return (size_t)2; };
  uint8_t fc = q[0];
  Field f = target(unit);
  String e;
  if (fc == 3 || fc == 4) {
    if (qn < 5) return fail(3);
    int a = (q[1] << 8) | q[2], c = (q[3] << 8) | q[4];
    if (c < 1 || c > 125) return fail(3);
    uint16_t w[125];
    { BusLockIf b(unit != 0); if (!mbRead(f, a, c, w, e)) return fail(exCode(e)); }
    r[0] = fc; r[1] = c * 2;
    for (int i = 0; i < c; i++) { r[2 + i * 2] = w[i] >> 8; r[3 + i * 2] = w[i]; }
    return 2 + c * 2;
  }
  if (fc == 6) {
    if (qn < 5) return fail(3);
    if (g_locked) return fail(4);
    int a = (q[1] << 8) | q[2]; uint16_t v = (q[3] << 8) | q[4];
    { BusLockIf b(unit != 0); if (!mbWrite(f, a, &v, 1, e)) return fail(exCode(e)); }
    memcpy(r, q, 5); logf("Modbus TCP: ghi Unit %d D%d = %u", unit, a, v); return 5;
  }
  if (fc == 16) {
    if (qn < 6) return fail(3);
    int a = (q[1] << 8) | q[2], c = (q[3] << 8) | q[4];
    if (c < 1 || c > 123 || q[5] != c * 2 || qn < (size_t)(6 + c * 2)) return fail(3);
    if (g_locked) return fail(4);
    uint16_t w[123]; for (int i = 0; i < c; i++) w[i] = (q[6 + i * 2] << 8) | q[7 + i * 2];
    { BusLockIf b(unit != 0); if (!mbWrite(f, a, w, c, e)) return fail(exCode(e)); }
    memcpy(r, q, 5); logf("Modbus TCP: ghi Unit %d D%d..%d", unit, a, a + c - 1); return 5;
  }
  // coil / discrete input: chỉ I/O của board (Unit 0)
  if (fc == 1 || fc == 2 || fc == 5) {
    if (unit != 0) return fail(1);
    if (qn < 5) return fail(3);
    int a = (q[1] << 8) | q[2];
    if (fc == 5) {
      if (g_locked) return fail(4);
      uint16_t raw = (q[3] << 8) | q[4];
      if (raw != 0xFF00 && raw != 0x0000) return fail(3);
      if (a < 0 || a > 7) return fail(2);
      uint16_t v = raw ? 1 : 0;
      { BusLockIf b(unit != 0); if (!mbWrite(f, 20 + a, &v, 1, e)) return fail(exCode(e)); }
      memcpy(r, q, 5); logf("Modbus TCP: coil DO%d = %u", a + 1, v); return 5;
    }
    int c = (q[3] << 8) | q[4];
    if (c < 1 || c > 8) return fail(3);
    if (a < 0 || a + c > 8) return fail(2);
    uint16_t w[1];
    { BusLockIf b(unit != 0); if (!mbRead(f, fc == 1 ? 1 : 0, 1, w, e)) return fail(exCode(e)); }   // D1 = DO gộp, D0 = DI gộp
    r[0] = fc; r[1] = 1; r[2] = (w[0] >> a) & ((1 << c) - 1);
    return 3;
  }
  return fail(1);
}

void serve() {
  while (s_cli && s_cli.available() && s_n < sizeof s_buf) { s_buf[s_n++] = s_cli.read(); s_lastRx = millis(); }
  while (s_n >= 7) {
    size_t len = (s_buf[4] << 8) | s_buf[5];
    if (s_buf[2] || s_buf[3] || len < 2 || len > 254) { s_cli.stop(); s_n = 0; return; }   // không phải Modbus TCP
    size_t total = 6 + len;
    if (s_n < total) break;
    uint8_t resp[270], pdu[260];
    size_t pn = handle(s_buf[6], s_buf + 7, len - 1, pdu);
    resp[0] = s_buf[0]; resp[1] = s_buf[1]; resp[2] = 0; resp[3] = 0; resp[4] = (pn + 1) >> 8; resp[5] = (pn + 1); resp[6] = s_buf[6];
    memcpy(resp + 7, pdu, pn);
    s_cli.write(resp, 7 + pn);
    memmove(s_buf, s_buf + total, s_n - total); s_n -= total;
  }
  if (s_cli && millis() - s_lastRx > kIdleMs) { s_cli.stop(); s_n = 0; }
}
}  // namespace

bool leaseActive() { return s_has && (int32_t)(s_until - millis()) > 0; }
IPAddress leaseHolder() { return s_holder; }
uint32_t leaseRemainingMs() { return leaseActive() ? s_until - millis() : 0; }

void leaseSet(const IPAddress& ip, uint32_t ttlMs) {
  if (g_locked) return;   // thiết bị bị khoá (báo mất): không nhận lease
  if (!leaseActive()) logf("Chế độ GATEWAY: PC %s giữ lease — dừng MQTTS, mở Modbus TCP slave cổng %d", ip.toString().c_str(), MBS_PORT);
  s_holder = ip; s_until = millis() + ttlMs; s_has = true;
}

void leaseRelease() { s_has = false; }

void slaveLoop() {
  if (!s_started) {
    if (!netUp()) return;
    s_srv.begin(); s_started = true;
    logf("Modbus TCP slave: cổng %d (chỉ nhận PC đang giữ lease)", MBS_PORT);
  }
  bool act = leaseActive() && !g_locked;
  if (s_wasActive && !act) { logf("Hết lease — về chế độ ĐỘC LẬP (MQTTS nối lại)"); s_cli.stop(); s_n = 0; s_has = false; }
  s_wasActive = act;
  NetworkClient c = s_srv.accept();
  if (c) {
    if (act && c.remoteIP() == s_holder) { s_cli.stop(); s_cli = c; s_cli.setNoDelay(true); s_n = 0; s_lastRx = millis(); }
    else c.stop();   // không phải PC giữ lease (hoặc đang độc lập): từ chối ngay
  }
  if (s_cli) { if (!act) { s_cli.stop(); s_n = 0; } else serve(); }
}
