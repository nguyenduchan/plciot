// Cài đặt lớp "giả phần cứng" cho bản giả lập trên PC. Chỉ biên dịch khi có -DGW_SIM (build-sim.ps1); bản board không bao giờ dùng file này.
#ifdef GW_SIM
#include <Arduino.h>
#include <ETH.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <NetworkUdp.h>
#include <NetworkClient.h>
#include <Wire.h>
#include "../src/board.h"

SerialPort Serial;
HardwareSerial Serial1;
TwoWire Wire;
FsClass LittleFS;
EthClass ETH;
NetworkClass Network;
EspClass ESP;

int simApiPort() { const char* p = getenv("SIM_API_PORT"); return p && atoi(p) > 0 ? atoi(p) : 8750; }
const char* simDataDir() { const char* p = getenv("SIM_DATA"); return p && *p ? p : "simdata"; }
static std::string dataPath(const char* path) { std::string p = simDataDir(); p += "/"; p += (path[0] == '/' ? path + 1 : path); return p; }

// ---------------------------------------------------------------- GPIO giả: DI lấy từ file <SIM_DATA>/di.txt (số thập phân hoặc 0x..), đổi lúc đang chạy được
static uint8_t simDi() {
  static uint32_t lastRead = 0; static uint8_t cached = 0;
  if (millis() - lastRead < 500) return cached;
  lastRead = millis();
  FILE* f = fopen(dataPath("di.txt").c_str(), "r");
  if (f) { char b[32] = {0}; fgets(b, sizeof b, f); fclose(f); cached = (uint8_t)strtol(b, nullptr, 0); }
  return cached;
}
void pinMode(int, int) {}
int digitalRead(int pin) {
  for (int i = 0; i < 8; i++) if (DI_PINS[i] == pin) { int on = (simDi() >> i) & 1; return DI_ACTIVE_LOW ? !on : on; }
  return HIGH;   // nút BOOT không nhấn
}
void digitalWrite(int, int) {}
void rgbLedWrite(int, uint8_t r, uint8_t g, uint8_t b) {
  static uint32_t last = 0xFFFFFFFF; uint32_t c = (r << 16) | (g << 8) | b;
  if (c == last) return; last = c;
  const char* name = r && g ? "VÀNG" : r ? "ĐỎ" : g ? "XANH LÁ" : b ? "XANH DƯƠNG" : "TẮT";
  printf("[sim] LED: %s\n", name); fflush(stdout);
}
uint64_t EspClass::getEfuseMac() { return 0x01004D495302ULL; }
void EspClass::restart() { printf("[sim] ESP.restart() — thoát; chạy lại gw-sim.exe\n"); exit(0); }

// ---------------------------------------------------------------- FreeRTOS giả
struct SimMutex { CRITICAL_SECTION cs; };
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex() { auto* m = new SimMutex; InitializeCriticalSection(&m->cs); return m; }
int xSemaphoreTakeRecursive(SemaphoreHandle_t h, TickType_t) { EnterCriticalSection(&((SimMutex*)h)->cs); return 1; }
int xSemaphoreGiveRecursive(SemaphoreHandle_t h) { LeaveCriticalSection(&((SimMutex*)h)->cs); return 1; }

struct SimTask { void (*fn)(void*); void* arg; HANDLE ev; DWORD tid; };
static std::vector<SimTask*> s_tasks;
static DWORD WINAPI taskEntry(LPVOID p) { auto* t = (SimTask*)p; t->fn(t->arg); return 0; }
int xTaskCreatePinnedToCore(void (*fn)(void*), const char*, uint32_t, void* arg, int, TaskHandle_t* out, int) {
  auto* t = new SimTask{fn, arg, CreateEvent(nullptr, FALSE, FALSE, nullptr), 0};
  s_tasks.push_back(t);
  CreateThread(nullptr, 0, taskEntry, t, 0, &t->tid);
  if (out) *out = t;
  return 1;
}
uint32_t ulTaskNotifyTake(int, TickType_t ms) {
  DWORD me = GetCurrentThreadId();
  for (auto* t : s_tasks) if (t->tid == me) return WaitForSingleObject(t->ev, ms) == WAIT_OBJECT_0 ? 1 : 0;
  Sleep(ms); return 0;
}
void xTaskNotifyGive(TaskHandle_t h) { if (h) SetEvent(((SimTask*)h)->ev); }

// ---------------------------------------------------------------- Ethernet giả
bool EthClass::begin(int, int, int, int, int, int, int, int, int) {
  if (Network.cb) { Network.cb(ARDUINO_EVENT_ETH_START, {}); Network.cb(ARDUINO_EVENT_ETH_CONNECTED, {}); Network.cb(ARDUINO_EVENT_ETH_GOT_IP, {}); }
  return true;
}
IPAddress EthClass::localIP() {
  static IPAddress ip; static bool done = false;
  if (done) return ip;
  done = true; ip = IPAddress(127, 0, 0, 1);
  char host[256];
  if (gethostname(host, sizeof host) == 0) {
    addrinfo hints = {}, *res = nullptr; hints.ai_family = AF_INET;
    if (getaddrinfo(host, nullptr, &hints, &res) == 0) {
      for (auto* a = res; a; a = a->ai_next) {
        auto* sa = (sockaddr_in*)a->ai_addr; uint8_t* b = (uint8_t*)&sa->sin_addr;
        if (b[0] != 127 && !(b[0] == 169 && b[1] == 254)) { ip = IPAddress(b[0], b[1], b[2], b[3]); break; }
      }
      freeaddrinfo(res);
    }
  }
  return ip;
}
String EthClass::macAddress() { const char* m = getenv("SIM_MAC"); return String(m && *m ? m : "02:53:49:4D:00:01"); }

// ---------------------------------------------------------------- LittleFS / NVS giả
File FsClass::open(const char* path, const char* mode) {
  std::string m = mode; m += "b";
  return File(fopen(dataPath(path).c_str(), m.c_str()));
}
bool FsClass::exists(const char* path) { return GetFileAttributesA(dataPath(path).c_str()) != INVALID_FILE_ATTRIBUTES; }
bool FsClass::remove(const char* path) { return DeleteFileA(dataPath(path).c_str()) != 0; }
bool FsClass::rename(const char* a, const char* b) { return MoveFileExA(dataPath(a).c_str(), dataPath(b).c_str(), MOVEFILE_REPLACE_EXISTING) != 0; }

String Preferences::getString(const char* key, const char* def) {
  FILE* f = fopen(dataPath((std::string("nvs-") + key + ".txt").c_str()).c_str(), "rb");
  if (!f) return String(def);
  std::string s; char b[512]; size_t n; while ((n = fread(b, 1, sizeof b, f)) > 0) s.append(b, n); fclose(f);
  return String(s);
}
size_t Preferences::putString(const char* key, const String& v) {
  FILE* f = fopen(dataPath((std::string("nvs-") + key + ".txt").c_str()).c_str(), "wb");
  if (!f) return 0; fwrite(v.c_str(), 1, v.length(), f); fclose(f); return v.length();
}
bool Preferences::remove(const char* key) { return DeleteFileA(dataPath((std::string("nvs-") + key + ".txt").c_str()).c_str()) != 0; }

// ---------------------------------------------------------------- RS485 giả: COM thật nếu SIM_COM=COMx
void HardwareSerial::begin(unsigned long baud, uint32_t mode, int, int) {
  end();
  const char* com = getenv("SIM_COM");
  if (!com || !*com) return;
  std::string name = std::string("\\\\.\\") + com;
  h_ = CreateFileA(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  if (h_ == INVALID_HANDLE_VALUE) { printf("[sim] Không mở được %s\n", com); return; }
  DCB d = {}; d.DCBlength = sizeof d; GetCommState(h_, &d);
  d.BaudRate = baud; d.ByteSize = 8; d.StopBits = ONESTOPBIT;
  d.Parity = mode == SERIAL_8E1 ? EVENPARITY : mode == SERIAL_8O1 ? ODDPARITY : NOPARITY; d.fParity = d.Parity != NOPARITY;
  SetCommState(h_, &d);
  COMMTIMEOUTS t = {}; t.ReadIntervalTimeout = MAXDWORD; SetCommTimeouts(h_, &t);   // đọc không chặn
  printf("[sim] RS485 = %s %lu baud\n", com, baud);
}
void HardwareSerial::end() { if (h_ != INVALID_HANDLE_VALUE) CloseHandle(h_); h_ = INVALID_HANDLE_VALUE; len_ = pos_ = 0; }
int HardwareSerial::available() {
  if (h_ == INVALID_HANDLE_VALUE) return 0;
  if (pos_ >= len_) { DWORD n = 0; ReadFile(h_, buf_, sizeof buf_, &n, nullptr); len_ = (int)n; pos_ = 0; }
  return len_ - pos_;
}
int HardwareSerial::read() { return available() > 0 ? buf_[pos_++] : -1; }
size_t HardwareSerial::write(const uint8_t* p, size_t n) {
  if (h_ == INVALID_HANDLE_VALUE) return n;
  DWORD w = 0; WriteFile(h_, p, (DWORD)n, &w, nullptr); return w;
}

// ---------------------------------------------------------------- TCP client
int NetworkClient::connect(const char* host, int port, int timeoutMs) {
  stop();
  addrinfo hints = {}, *res = nullptr; hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;
  char ps[8]; snprintf(ps, sizeof ps, "%d", port);
  if (getaddrinfo(host, ps, &hints, &res) != 0) return 0;
  s_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  u_long nb = 1; ioctlsocket(s_, FIONBIO, &nb);
  ::connect(s_, res->ai_addr, (int)res->ai_addrlen);
  freeaddrinfo(res);
  fd_set w; FD_ZERO(&w); FD_SET(s_, &w);
  timeval tv = {timeoutMs / 1000, (timeoutMs % 1000) * 1000};
  if (select(0, nullptr, &w, nullptr, &tv) <= 0) { stop(); return 0; }
  int err = 0; int len = sizeof err; getsockopt(s_, SOL_SOCKET, SO_ERROR, (char*)&err, &len);
  if (err) { stop(); return 0; }
  return 1;
}
bool NetworkClient::connected() {
  if (s_ == INVALID_SOCKET) return false;
  char c; int r = recv(s_, &c, 1, MSG_PEEK);
  if (r == 0) return false;
  if (r < 0 && WSAGetLastError() != WSAEWOULDBLOCK) return false;
  return true;
}
void NetworkClient::stop() { if (s_ != INVALID_SOCKET) closesocket(s_); s_ = INVALID_SOCKET; }
void NetworkClient::setNoDelay(bool on) { int v = on; if (s_ != INVALID_SOCKET) setsockopt(s_, IPPROTO_TCP, TCP_NODELAY, (char*)&v, sizeof v); }
int NetworkClient::available() { u_long n = 0; if (s_ == INVALID_SOCKET || ioctlsocket(s_, FIONREAD, &n) != 0) return 0; return (int)n; }
int NetworkClient::read() { uint8_t c; return s_ != INVALID_SOCKET && recv(s_, (char*)&c, 1, 0) == 1 ? c : -1; }
size_t NetworkClient::write(const uint8_t* p, size_t n) {
  size_t k = 0; uint32_t t0 = millis();
  while (k < n && s_ != INVALID_SOCKET && millis() - t0 < 2000) {
    int r = send(s_, (const char*)p + k, (int)(n - k), 0);
    if (r > 0) k += r; else if (WSAGetLastError() == WSAEWOULDBLOCK) Sleep(1); else break;
  }
  return k;
}

// ---------------------------------------------------------------- UDP
bool NetworkUDP::begin(int port) {
  s_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  BOOL on = TRUE; setsockopt(s_, SOL_SOCKET, SO_REUSEADDR, (char*)&on, sizeof on); setsockopt(s_, SOL_SOCKET, SO_BROADCAST, (char*)&on, sizeof on);
  sockaddr_in a = {}; a.sin_family = AF_INET; a.sin_port = htons((u_short)port); a.sin_addr.s_addr = INADDR_ANY;
  if (bind(s_, (sockaddr*)&a, sizeof a) != 0) { printf("[sim] Không mở được UDP %d\n", port); closesocket(s_); s_ = INVALID_SOCKET; return false; }
  u_long nb = 1; ioctlsocket(s_, FIONBIO, &nb);
  return true;
}
int NetworkUDP::parsePacket() {
  if (s_ == INVALID_SOCKET) return 0;
  int fl = sizeof from_;
  len_ = recvfrom(s_, buf_, sizeof buf_, 0, (sockaddr*)&from_, &fl);
  return len_ > 0 ? len_ : 0;
}
int NetworkUDP::read(char* b, int n) { int k = min(n, len_); if (k > 0) memcpy(b, buf_, k); return k; }
IPAddress NetworkUDP::remoteIP() const { const uint8_t* b = (const uint8_t*)&from_.sin_addr; return IPAddress(b[0], b[1], b[2], b[3]); }
int NetworkUDP::endPacket() { return sendto(s_, out_.data(), (int)out_.size(), 0, (const sockaddr*)&from_, sizeof from_) > 0; }

// ---------------------------------------------------------------- HTTP server
void WebServer::begin() {
  ls_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  sockaddr_in a = {}; a.sin_family = AF_INET; a.sin_port = htons((u_short)port_); a.sin_addr.s_addr = INADDR_ANY;
  if (bind(ls_, (sockaddr*)&a, sizeof a) != 0 || listen(ls_, 8) != 0) { printf("[sim] KHÔNG mở được cổng HTTP %d (đang có chương trình khác dùng? đặt SIM_API_PORT)\n", port_); return; }
  u_long nb = 1; ioctlsocket(ls_, FIONBIO, &nb);
}

static bool recvLine(SOCKET s, std::string& acc, size_t want, uint32_t deadline) {
  while (acc.size() < want && millis() < deadline) {
    char b[4096]; int r = recv(s, b, sizeof b, 0);
    if (r > 0) acc.append(b, r); else if (r == 0) return false; else if (WSAGetLastError() == WSAEWOULDBLOCK) Sleep(1); else return false;
  }
  return acc.size() >= want;
}

void WebServer::handleClient() {
  if (ls_ == INVALID_SOCKET) return;
  sockaddr_in from = {}; int fl = sizeof from;
  cs_ = accept(ls_, (sockaddr*)&from, &fl);
  if (cs_ == INVALID_SOCKET) return;
  u_long nb = 1; ioctlsocket(cs_, FIONBIO, &nb);
  const uint8_t* ip = (const uint8_t*)&from.sin_addr; client_.ip = IPAddress(ip[0], ip[1], ip[2], ip[3]);
  std::string acc; uint32_t deadline = millis() + 10000; size_t hdrEnd;
  while ((hdrEnd = acc.find("\r\n\r\n")) == std::string::npos) {
    if (acc.size() > 65536 || !recvLine(cs_, acc, acc.size() + 1, deadline)) { closesocket(cs_); return; }
  }
  std::string head = acc.substr(0, hdrEnd);
  size_t sp1 = head.find(' '), sp2 = head.find(' ', sp1 + 1);
  std::string method = head.substr(0, sp1), path = head.substr(sp1 + 1, sp2 - sp1 - 1);
  if (path.find('?') != std::string::npos) path = path.substr(0, path.find('?'));
  hdr_.clear();
  size_t p = head.find("\r\n");
  while (p != std::string::npos) {
    size_t q = head.find("\r\n", p + 2);
    std::string line = head.substr(p + 2, q == std::string::npos ? std::string::npos : q - p - 2);
    size_t c = line.find(':');
    if (c != std::string::npos) {
      std::string k = line.substr(0, c), v = line.substr(c + 1);
      for (auto& ch : k) ch = (char)tolower((unsigned char)ch);
      while (!v.empty() && v[0] == ' ') v.erase(0, 1);
      hdr_[k] = v;
    }
    p = q;
  }
  size_t len = hdr_.count("content-length") ? strtoul(hdr_["content-length"].c_str(), nullptr, 10) : 0;
  if (len > 4000000) len = 0;
  body_ = acc.substr(hdrEnd + 4);
  if (body_.size() < len && !recvLine(cs_, body_, len, deadline)) { closesocket(cs_); return; }
  HTTPMethod m = method == "GET" ? HTTP_GET : method == "POST" ? HTTP_POST : method == "PUT" ? HTTP_PUT : HTTP_ANY;
  sent_ = false;
  bool found = false;
  for (auto& r : routes_) if (r.path == path && (r.m == HTTP_ANY || r.m == m)) { r.h(); found = true; break; }
  if (!found && notFound_) notFound_();
  if (!sent_) send(500, "text/plain", "no response");
  closesocket(cs_); cs_ = INVALID_SOCKET;
}

String WebServer::arg(const char* name) { return strcmp(name, "plain") == 0 ? String(body_) : String(); }
String WebServer::header(const char* name) {
  std::string k = name; for (auto& ch : k) ch = (char)tolower((unsigned char)ch);
  auto it = hdr_.find(k); return it == hdr_.end() ? String() : String(it->second);
}
void WebServer::send(int code, const char* type, const String& body) {
  if (sent_ || cs_ == INVALID_SOCKET) return;
  sent_ = true;
  const char* reason = code == 200 ? "OK" : code == 400 ? "Bad Request" : code == 401 ? "Unauthorized" : code == 404 ? "Not Found" : code == 429 ? "Too Many Requests" : "Error";
  char h[256]; int n = snprintf(h, sizeof h, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nConnection: close\r\n\r\n", code, reason, type, body.length());
  std::string out(h, n); out += body.s;
  size_t k = 0; uint32_t t0 = millis();
  while (k < out.size() && millis() - t0 < 5000) { int r = ::send(cs_, out.data() + k, (int)(out.size() - k), 0); if (r > 0) k += r; else if (WSAGetLastError() == WSAEWOULDBLOCK) Sleep(1); else break; }
}
#endif  // GW_SIM
