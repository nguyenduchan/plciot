#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Client.h>
#include <mbedtls/ssl.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/x509_crt.h>
// TLS client của bản giả lập: CHÍNH mbedtls (cùng thư viện ESP-IDF dùng) chạy trên socket Windows.
// Cùng các hàm firmware gọi trên NetworkClientSecure của Arduino-ESP32: setInsecure, setHandshakeTimeout, connect, getPeerCertificate…
class NetworkClientSecure : public Client {
 public:
  NetworkClientSecure();
  ~NetworkClientSecure();
  void setInsecure() { insecure_ = true; }
  void setHandshakeTimeout(unsigned long sec) { hsTimeoutMs_ = sec * 1000; }
  /// Kiểm chứng chỉ server theo kho chứng chỉ gốc của Windows (dùng cho HTTPS; MQTTS của firmware dùng setInsecure + ghim).
  void useSystemRoots() { insecure_ = false; }
  int connect(IPAddress ip, uint16_t port) override { return connect(ip.toString().c_str(), port); }
  int connect(const char* host, uint16_t port) override;
  size_t write(uint8_t c) override { return write(&c, 1); }
  size_t write(const uint8_t* p, size_t n) override;
  int available() override;
  int read() override;
  int read(uint8_t* buf, size_t n) override;
  int peek() override;
  void flush() override {}
  void stop() override;
  uint8_t connected() override;
  operator bool() override { return connected(); }
  const mbedtls_x509_crt* getPeerCertificate() { return open_ ? mbedtls_ssl_get_peer_cert(&ssl_) : nullptr; }
  SOCKET socket() const { return s_; }
 private:
  bool fill(int waitMs);
  SOCKET s_ = INVALID_SOCKET;
  bool insecure_ = false, open_ = false, inited_ = false;
  unsigned long hsTimeoutMs_ = 10000;
  mbedtls_ssl_context ssl_;
  mbedtls_ssl_config conf_;
  uint8_t rx_[2048]; int rxLen_ = 0, rxPos_ = 0;
};
