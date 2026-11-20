// Máy chủ HTTP/HTTPS tối giản cho API cài đặt — mbedtls trên NetworkServer/NetworkClient của Arduino-ESP32
// (cùng mã chạy trên board và bản giả lập trên PC). Mỗi lúc một kết nối, "Connection: close".
//   cổng 443: HTTPS, chứng chỉ tự ký từ khoá danh tính (GatewayApp ghim khoá, dấu nhận dạng = mã phần cứng)
//   cổng 80 : HTTP thường, chỉ trang trạng thái (không nhận lệnh cấu hình — xem api.cpp)
#include "gw.h"
#include "https.h"
#include <NetworkServer.h>
#include <mbedtls/ssl.h>
#include <mbedtls/pk.h>
#include <mbedtls/x509_crt.h>
#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h>
#include <esp_random.h>
#if defined(MBEDTLS_PSA_CRYPTO_C)
#include <psa/crypto.h>
#endif

namespace {
int rng(void*, unsigned char* out, size_t len) { esp_fill_random(out, len); return 0; }

int bioSend(void* ctx, const unsigned char* buf, size_t len) {
  auto* c = (NetworkClient*)ctx;
  if (!c->connected()) return MBEDTLS_ERR_NET_CONN_RESET;
  size_t n = c->write(buf, len);
  return n > 0 ? (int)n : MBEDTLS_ERR_SSL_WANT_WRITE;
}
int bioRecv(void* ctx, unsigned char* buf, size_t len) {
  auto* c = (NetworkClient*)ctx;
  int a = c->available();
  if (a <= 0) return c->connected() ? MBEDTLS_ERR_SSL_WANT_READ : MBEDTLS_ERR_NET_CONN_RESET;
  int n = c->read(buf, min((int)len, a));
  return n > 0 ? n : MBEDTLS_ERR_SSL_WANT_READ;
}

const char* reason(int code) {
  switch (code) { case 200: return "OK"; case 400: return "Bad Request"; case 401: return "Unauthorized"; case 403: return "Forbidden";
    case 404: return "Not Found"; case 413: return "Payload Too Large"; case 429: return "Too Many Requests"; default: return "Error"; }
}
}  // namespace

struct HttpServer::Impl {
  NetworkServer server;
  bool tls;
  mbedtls_ssl_config conf;
  mbedtls_x509_crt cert;
  bool ready = false;
  explicit Impl(int port, bool t) : server(port), tls(t) {}
};

HttpServer::HttpServer(int port, bool tls) : port_(port), tls_(tls) {}

bool HttpServer::begin() {
  impl_ = new Impl(port_, tls_);
  if (tls_) {
#if defined(MBEDTLS_PSA_CRYPTO_C)
    psa_crypto_init();   // TLS 1.3 của mbedtls 3.x cần PSA
#endif
    auto der = tlsCertDer();
    if (der.empty()) { logf("HTTPS: không tạo được chứng chỉ — tắt cổng %d", port_); return false; }
    mbedtls_x509_crt_init(&impl_->cert);
    mbedtls_ssl_config_init(&impl_->conf);
    if (mbedtls_x509_crt_parse_der(&impl_->cert, der.data(), der.size()) != 0
        || mbedtls_ssl_config_defaults(&impl_->conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT) != 0
        || mbedtls_ssl_conf_own_cert(&impl_->conf, &impl_->cert, idKey()) != 0) {
      logf("HTTPS: cấu hình TLS lỗi — tắt cổng %d", port_); return false;
    }
#ifdef GW_SIM
    mbedtls_ssl_conf_max_tls_version(&impl_->conf, MBEDTLS_SSL_VERSION_TLS1_2);   // mbedtls build bằng MinGW-w64 mới: TLS 1.3 lỗi nội bộ (-0x6C00); TLS 1.2 chạy tốt
#endif
    mbedtls_ssl_conf_rng(&impl_->conf, rng, nullptr);
    mbedtls_ssl_conf_authmode(&impl_->conf, MBEDTLS_SSL_VERIFY_NONE);   // admin xác thực bằng chữ ký khoá PC (api.cpp), không bằng chứng chỉ client
  }
  impl_->server.begin();
  impl_->ready = true;
  return true;
}

/// Đọc trọn một yêu cầu (đầu + thân) từ kênh đã sẵn sàng; false = hỏng / quá lớn / hết giờ.
static bool readRequest(std::function<int(uint8_t*, size_t)> rd, HttpRequest& q, uint32_t deadline) {
  std::string acc; size_t he;
  uint8_t b[512];
  while ((he = acc.find("\r\n\r\n")) == std::string::npos) {
    if (acc.size() > 8192 || millis() > deadline) return false;
    int n = rd(b, sizeof b);
    if (n < 0) return false;
    if (n == 0) { delay(2); continue; }
    acc.append((const char*)b, n);
  }
  std::string head = acc.substr(0, he);
  size_t sp1 = head.find(' '), sp2 = head.find(' ', sp1 + 1);
  if (sp1 == std::string::npos || sp2 == std::string::npos) return false;
  q.method = String(head.substr(0, sp1).c_str());
  std::string path = head.substr(sp1 + 1, sp2 - sp1 - 1);
  if (path.find('?') != std::string::npos) path = path.substr(0, path.find('?'));
  q.path = String(path.c_str());
  size_t p = head.find("\r\n"); size_t len = 0;
  while (p != std::string::npos) {
    size_t e = head.find("\r\n", p + 2);
    std::string line = head.substr(p + 2, e == std::string::npos ? std::string::npos : e - p - 2);
    size_t c = line.find(':');
    if (c != std::string::npos) {
      std::string k = line.substr(0, c), v = line.substr(c + 1);
      for (auto& ch : k) ch = (char)tolower((unsigned char)ch);
      while (!v.empty() && v[0] == ' ') v.erase(0, 1);
      if (k == "content-length") len = strtoul(v.c_str(), nullptr, 10);
      if (k == "authorization") q.auth = String(v.c_str());
    }
    p = e;
  }
  if (len > 65536) return false;
  std::string body = acc.substr(he + 4);
  while (body.size() < len) {
    if (millis() > deadline) return false;
    int n = rd(b, sizeof b);
    if (n < 0) return false;
    if (n == 0) { delay(2); continue; }
    body.append((const char*)b, n);
  }
  q.body = String(body.substr(0, len).c_str());
  return true;
}

void HttpServer::handle(std::function<void(const HttpRequest&, HttpResponse&)> route) {
  if (!impl_ || !impl_->ready) return;
  NetworkClient c = impl_->server.accept();
  if (!c) return;
  HttpRequest q; HttpResponse r; q.ip = c.remoteIP(); q.tls = tls_;
  uint32_t deadline = millis() + 10000;
  if (!tls_) {
    auto rd = [&](uint8_t* b, size_t n) -> int { int a = c.available(); if (a <= 0) return c.connected() ? 0 : -1; return c.read(b, min((int)n, a)); };
    if (readRequest(rd, q, deadline)) { route(q, r); String s = r.serialize(); c.write((const uint8_t*)s.c_str(), s.length()); }
    c.stop();
    return;
  }
  mbedtls_ssl_context ssl; mbedtls_ssl_init(&ssl);
  bool ok = mbedtls_ssl_setup(&ssl, &impl_->conf) == 0;
  if (ok) {
    mbedtls_ssl_set_bio(&ssl, &c, bioSend, bioRecv, nullptr);
    int e;
    while ((e = mbedtls_ssl_handshake(&ssl)) != 0) {
      if ((e != MBEDTLS_ERR_SSL_WANT_READ && e != MBEDTLS_ERR_SSL_WANT_WRITE) || millis() > deadline) { ok = false; break; }
      delay(1);
    }
  }
  if (ok) {
    auto rd = [&](uint8_t* b, size_t n) -> int {
      int e = mbedtls_ssl_read(&ssl, b, n);
      if (e > 0) return e;
      if (e == MBEDTLS_ERR_SSL_WANT_READ || e == MBEDTLS_ERR_SSL_WANT_WRITE) return 0;
#ifdef MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET
      if (e == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) return 0;
#endif
      return -1;
    };
    if (readRequest(rd, q, deadline)) {
      route(q, r);
      String s = r.serialize();
      size_t k = 0;
      while (k < s.length() && millis() < deadline) {
        int e = mbedtls_ssl_write(&ssl, (const uint8_t*)s.c_str() + k, s.length() - k);
        if (e > 0) k += e; else if (e != MBEDTLS_ERR_SSL_WANT_WRITE && e != MBEDTLS_ERR_SSL_WANT_READ) break; else delay(1);
      }
    }
    mbedtls_ssl_close_notify(&ssl);
  }
  mbedtls_ssl_free(&ssl);
  c.stop();
}

String HttpResponse::serialize() const {
  String h = "HTTP/1.1 " + String(code) + " " + reason(code) + "\r\nContent-Type: " + type + "\r\nContent-Length: " + String((unsigned)body.length()) + "\r\nConnection: close\r\n\r\n";
  return h + body;
}
