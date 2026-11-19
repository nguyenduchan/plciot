// Lớp vận chuyển của bản giả lập: TLS (mbedtls thật) trên socket Windows + esp_http_client tối giản + CA gốc từ kho Windows.
// Nhờ lớp này, cloud.cpp và crypto.cpp CỦA BOARD biên dịch và chạy nguyên văn trên PC. Chỉ biên dịch khi có -DGW_SIM.
#ifdef GW_SIM
#include <NetworkClientSecure.h>
#include <esp_http_client.h>
#include <esp_crt_bundle.h>
#include <esp_random.h>
#include <wincrypt.h>
#include <psa/crypto.h>
#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h>   // chỉ lấy mã lỗi MBEDTLS_ERR_NET_* (MBEDTLS_NET_C tắt)

// ---------------------------------------------------------------- nền của mbedtls trên Windows
extern "C" int mbedtls_hardware_poll(void*, unsigned char* out, size_t len, size_t* olen) {
  esp_fill_random(out, len); *olen = len; return 0;
}
extern "C" struct tm* mbedtls_platform_gmtime_r(const time_t* tt, struct tm* buf) {
  struct tm* t = gmtime(tt); if (!t) return nullptr; *buf = *t; return buf;
}

namespace {
int rng(void*, unsigned char* out, size_t len) { esp_fill_random(out, len); return 0; }

mbedtls_x509_crt* roots() {
  static mbedtls_x509_crt chain; static bool loaded = false;
  if (loaded) return &chain;
  loaded = true;
  mbedtls_x509_crt_init(&chain);
  int n = 0;
  for (const char* storeName : {"ROOT", "CA"}) {
    HCERTSTORE st = CertOpenSystemStoreA(0, storeName);
    if (!st) continue;
    PCCERT_CONTEXT c = nullptr;
    while ((c = CertEnumCertificatesInStore(st, c)) != nullptr)
      if (mbedtls_x509_crt_parse_der(&chain, c->pbCertEncoded, c->cbCertEncoded) == 0) n++;
    CertCloseStore(st, 0);
  }
  printf("[sim] Nạp %d chứng chỉ gốc từ kho Windows (thay bộ CA của ESP-IDF)\n", n);
  return &chain;
}

void setTimeout(SOCKET s, DWORD ms) { setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&ms, sizeof ms); setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&ms, sizeof ms); }

int sendCb(void* ctx, const unsigned char* buf, size_t len) {
  SOCKET s = *(SOCKET*)ctx;
  int r = send(s, (const char*)buf, (int)len, 0);
  if (r >= 0) return r;
  int e = WSAGetLastError();
  return e == WSAETIMEDOUT || e == WSAEWOULDBLOCK ? MBEDTLS_ERR_SSL_WANT_WRITE : MBEDTLS_ERR_NET_SEND_FAILED;
}
int recvCb(void* ctx, unsigned char* buf, size_t len) {
  SOCKET s = *(SOCKET*)ctx;
  int r = recv(s, (char*)buf, (int)len, 0);
  if (r > 0) return r;
  if (r == 0) return MBEDTLS_ERR_NET_CONN_RESET;
  int e = WSAGetLastError();
  return e == WSAETIMEDOUT || e == WSAEWOULDBLOCK ? MBEDTLS_ERR_SSL_WANT_READ : MBEDTLS_ERR_NET_RECV_FAILED;
}
String tlsErr(int r) { char b[128]; mbedtls_strerror(r, b, sizeof b); return String(b); }
}  // namespace

// ---------------------------------------------------------------- NetworkClientSecure
NetworkClientSecure::NetworkClientSecure() {}
NetworkClientSecure::~NetworkClientSecure() { stop(); }

int NetworkClientSecure::connect(const char* host, uint16_t port) {
  stop();
  static bool psa = false;
  if (!psa) { psa_crypto_init(); psa = true; }   // TLS 1.3 của mbedtls 3.6 cần PSA
  addrinfo hints = {}, *res = nullptr; hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;
  char ps[8]; snprintf(ps, sizeof ps, "%u", port);
  if (getaddrinfo(host, ps, &hints, &res) != 0) { printf("[sim] TLS: không phân giải được %s\n", host); return 0; }
  s_ = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  u_long nb = 1; ioctlsocket(s_, FIONBIO, &nb);
  ::connect(s_, res->ai_addr, (int)res->ai_addrlen);
  freeaddrinfo(res);
  fd_set w; FD_ZERO(&w); FD_SET(s_, &w);
  timeval tv = {(long)(hsTimeoutMs_ / 1000), 0};
  int err = 0; int el = sizeof err;
  if (select(0, nullptr, &w, nullptr, &tv) <= 0 || (getsockopt(s_, SOL_SOCKET, SO_ERROR, (char*)&err, &el), err)) { printf("[sim] TLS: không nối TCP được %s:%u\n", host, port); stop(); return 0; }
  nb = 0; ioctlsocket(s_, FIONBIO, &nb);
  setTimeout(s_, hsTimeoutMs_);

  mbedtls_ssl_init(&ssl_); mbedtls_ssl_config_init(&conf_); inited_ = true;
  mbedtls_ssl_config_defaults(&conf_, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT);
  mbedtls_ssl_conf_rng(&conf_, rng, nullptr);
  if (insecure_) mbedtls_ssl_conf_authmode(&conf_, MBEDTLS_SSL_VERIFY_NONE);
  else { mbedtls_ssl_conf_authmode(&conf_, MBEDTLS_SSL_VERIFY_REQUIRED); mbedtls_ssl_conf_ca_chain(&conf_, roots(), nullptr); }
  mbedtls_ssl_setup(&ssl_, &conf_);
  mbedtls_ssl_set_hostname(&ssl_, host);
  mbedtls_ssl_set_bio(&ssl_, &s_, sendCb, recvCb, nullptr);
  uint32_t t0 = millis(); int r;
  while ((r = mbedtls_ssl_handshake(&ssl_)) != 0) {
    if ((r != MBEDTLS_ERR_SSL_WANT_READ && r != MBEDTLS_ERR_SSL_WANT_WRITE) || millis() - t0 > hsTimeoutMs_) {
      printf("[sim] TLS bắt tay %s:%u lỗi: %s\n", host, port, tlsErr(r).c_str());
      stop(); return 0;
    }
  }
  setTimeout(s_, 100);   // sau bắt tay: đọc ngắn để available() không chặn lâu
  open_ = true; rxLen_ = rxPos_ = 0;
  return 1;
}

bool NetworkClientSecure::fill(int waitMs) {
  if (!open_) return false;
  if (rxPos_ < rxLen_) return true;
  if (mbedtls_ssl_get_bytes_avail(&ssl_) == 0) {
    fd_set rd; FD_ZERO(&rd); FD_SET(s_, &rd);
    timeval tv = {waitMs / 1000, (waitMs % 1000) * 1000};
    if (select(0, &rd, nullptr, nullptr, &tv) <= 0) return false;
  }
  for (int tries = 0; tries < 4; tries++) {
    int r = mbedtls_ssl_read(&ssl_, rx_, sizeof rx_);
    if (r > 0) { rxLen_ = r; rxPos_ = 0; return true; }
    if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return false;
    if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) continue;   // TLS 1.3: vé phiên, không phải dữ liệu
    open_ = false;   // 0 = server đóng, còn lại = lỗi
    return false;
  }
  return false;
}

int NetworkClientSecure::available() { fill(0); return rxLen_ - rxPos_; }
int NetworkClientSecure::read() { if (!fill(0)) return -1; return rx_[rxPos_++]; }
int NetworkClientSecure::read(uint8_t* buf, size_t n) {
  if (!fill(0)) return -1;
  int k = min((int)n, rxLen_ - rxPos_); memcpy(buf, rx_ + rxPos_, k); rxPos_ += k; return k;
}
int NetworkClientSecure::peek() { if (!fill(0)) return -1; return rx_[rxPos_]; }
size_t NetworkClientSecure::write(const uint8_t* p, size_t n) {
  if (!open_) return 0;
  size_t k = 0; uint32_t t0 = millis();
  while (k < n && millis() - t0 < 5000) {
    int r = mbedtls_ssl_write(&ssl_, p + k, n - k);
    if (r > 0) k += r;
    else if (r != MBEDTLS_ERR_SSL_WANT_WRITE && r != MBEDTLS_ERR_SSL_WANT_READ) { open_ = false; break; }
  }
  return k;
}
uint8_t NetworkClientSecure::connected() { if (open_) fill(0); return open_ || rxPos_ < rxLen_; }
void NetworkClientSecure::stop() {
  if (open_) mbedtls_ssl_close_notify(&ssl_);
  open_ = false;
  if (inited_) { mbedtls_ssl_free(&ssl_); mbedtls_ssl_config_free(&conf_); inited_ = false; }
  if (s_ != INVALID_SOCKET) closesocket(s_);
  s_ = INVALID_SOCKET; rxLen_ = rxPos_ = 0;
}

// ---------------------------------------------------------------- esp_http_client (HTTPS POST đơn giản, Connection: close)
struct esp_http_client {
  esp_http_client_config_t cfg;
  std::string url;
  std::vector<std::pair<std::string, std::string>> headers;
  std::string body;
  int status = -1;
};

const char* esp_err_to_name(esp_err_t e) { return e == ESP_OK ? "ESP_OK" : "ESP_FAIL"; }
esp_err_t esp_crt_bundle_attach(void*) { return ESP_OK; }

esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t* c) {
  auto* h = new esp_http_client; h->cfg = *c; h->url = c->url ? c->url : ""; return h;
}
esp_err_t esp_http_client_set_header(esp_http_client_handle_t h, const char* k, const char* v) { h->headers.push_back({k, v}); return ESP_OK; }
esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t h, const char* d, int n) { h->body.assign(d, n); return ESP_OK; }
int esp_http_client_get_status_code(esp_http_client_handle_t h) { return h->status; }
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t h) { delete h; return ESP_OK; }

esp_err_t esp_http_client_perform(esp_http_client_handle_t h) {
  std::string u = h->url; bool https = u.compare(0, 8, "https://") == 0;
  if (!https && u.compare(0, 7, "http://") != 0) return ESP_FAIL;
  u = u.substr(https ? 8 : 7);
  size_t sl = u.find('/'); std::string hostport = u.substr(0, sl), path = sl == std::string::npos ? "/" : u.substr(sl);
  size_t co = hostport.find(':'); std::string host = hostport.substr(0, co);
  int port = co == std::string::npos ? (https ? 443 : 80) : atoi(hostport.c_str() + co + 1);
  if (!https) { printf("[sim] esp_http_client: chỉ hỗ trợ https\n"); return ESP_FAIL; }
  NetworkClientSecure c;
  if (h->cfg.crt_bundle_attach) c.useSystemRoots(); else c.setInsecure();
  c.setHandshakeTimeout(max(5, h->cfg.timeout_ms / 1000));
  if (!c.connect(host.c_str(), (uint16_t)port)) return ESP_FAIL;
  std::string req = std::string(h->cfg.method == HTTP_METHOD_POST ? "POST " : "GET ") + path + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\nUser-Agent: plciot-gw-sim\r\n";
  for (auto& kv : h->headers) req += kv.first + ": " + kv.second + "\r\n";
  if (h->cfg.method == HTTP_METHOD_POST) { char b[48]; snprintf(b, sizeof b, "Content-Length: %u\r\n", (unsigned)h->body.size()); req += b; }
  req += "\r\n"; req += h->body;
  if (c.write((const uint8_t*)req.data(), req.size()) != req.size()) return ESP_FAIL;
  std::string resp; uint32_t t0 = millis();
  while (millis() - t0 < (uint32_t)h->cfg.timeout_ms) {
    uint8_t b[2048]; int n = c.read(b, sizeof b);
    if (n > 0) { resp.append((const char*)b, n); continue; }
    if (!c.connected()) break;
    Sleep(5);
  }
  size_t he = resp.find("\r\n\r\n");
  if (he == std::string::npos || resp.compare(0, 5, "HTTP/") != 0) return ESP_FAIL;
  h->status = atoi(resp.c_str() + resp.find(' ') + 1);
  std::string head = resp.substr(0, he), body = resp.substr(he + 4);
  bool chunked = false;
  size_t p = head.find("\r\n");
  while (p != std::string::npos) {
    size_t q = head.find("\r\n", p + 2);
    std::string line = head.substr(p + 2, q == std::string::npos ? std::string::npos : q - p - 2);
    size_t cc = line.find(':');
    if (cc != std::string::npos) {
      std::string k = line.substr(0, cc), v = line.substr(cc + 1); while (!v.empty() && v[0] == ' ') v.erase(0, 1);
      std::string kl = k; for (auto& ch : kl) ch = (char)tolower((unsigned char)ch);
      if (kl == "transfer-encoding" && v.find("chunked") != std::string::npos) chunked = true;
      if (h->cfg.event_handler) {
        esp_http_client_event_t e = {}; e.event_id = HTTP_EVENT_ON_HEADER; e.client = h; e.user_data = h->cfg.user_data;
        e.header_key = &k[0]; e.header_value = &v[0];
        h->cfg.event_handler(&e);
      }
    }
    p = q;
  }
  if (chunked) {
    std::string out; size_t i = 0;
    while (i < body.size()) {
      size_t le = body.find("\r\n", i); if (le == std::string::npos) break;
      size_t n = strtoul(body.substr(i, le - i).c_str(), nullptr, 16);
      if (n == 0) break;
      out += body.substr(le + 2, n); i = le + 2 + n + 2;
    }
    body = out;
  }
  if (h->cfg.event_handler && !body.empty()) {
    esp_http_client_event_t e = {}; e.event_id = HTTP_EVENT_ON_DATA; e.client = h; e.user_data = h->cfg.user_data;
    e.data = &body[0]; e.data_len = (int)body.size();
    h->cfg.event_handler(&e);
  }
  return ESP_OK;
}
#endif  // GW_SIM
