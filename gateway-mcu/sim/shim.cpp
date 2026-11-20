// Cài đặt lớp "giả phần cứng" cho bản giả lập trên PC. Chỉ biên dịch khi có -DGW_SIM (build-sim.ps1); bản board không bao giờ dùng file này.
#ifdef GW_SIM
#include <Arduino.h>
#include <ETH.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <NetworkServer.h>
#include <NetworkUdp.h>
#include <NetworkClient.h>
#include <Wire.h>
#include "../src/board.h"
uint8_t ioDo();   // io.cpp: trạng thái logic của DO (cho SIM_LOOPBACK)

SerialPort Serial;
HardwareSerial Serial1;
TwoWire Wire;
FsClass LittleFS;
EthClass ETH;
NetworkClass Network;
EspClass ESP;

int simApiPort() { const char* p = getenv("SIM_API_PORT"); return p && atoi(p) > 0 ? atoi(p) : 443; }   // mặc định như board (HTTPS 443)
int simStatusPort() { const char* p = getenv("SIM_HTTP_PORT"); return p && atoi(p) > 0 ? atoi(p) : 80; }
const char* simDataDir() { const char* p = getenv("SIM_DATA"); return p && *p ? p : "simdata"; }
static std::string dataPath(const char* path) { std::string p = simDataDir(); p += "/"; p += (path[0] == '/' ? path + 1 : path); return p; }

// ---------------------------------------------------------------- GPIO giả: DI lấy từ file <SIM_DATA>/di.txt (số thập phân hoặc 0x..), đổi lúc đang chạy được
static uint8_t simFileDi() {
  static uint32_t lastRead = 0; static uint8_t cached = 0;
  if (millis() - lastRead < 500) return cached;
  lastRead = millis();
  FILE* f = fopen(dataPath("di.txt").c_str(), "r");
  if (f) { char b[32] = {0}; fgets(b, sizeof b, f); fclose(f); cached = (uint8_t)strtol(b, nullptr, 0); }
  return cached;
}
// SIM_LOOPBACK=<giây>: mô phỏng dây DOn → relay/cảm biến → DIn: DIn lặp lại DOn sau bấy nhiêu giây (số âm = relay hỏng, DI không đổi theo DO).
// Dùng để thử "lệnh → phản hồi thật" mà không cần phần cứng; chỉ có trong bản giả lập.
static uint8_t simDi() {
  uint8_t fileDi = simFileDi();
  const char* lb = getenv("SIM_LOOPBACK");
  if (!lb || !*lb || atof(lb) < 0) return fileDi;
  static uint8_t seen = 0, shown = 0; static uint32_t chg[8] = {0};
  uint8_t d = ioDo(); uint32_t now = millis();
  for (int i = 0; i < 8; i++) {
    uint8_t bit = (d >> i) & 1;
    if (bit != ((seen >> i) & 1)) { seen ^= (1 << i); chg[i] = now; }
    if (bit != ((shown >> i) & 1) && now - chg[i] >= (uint32_t)(atof(lb) * 1000)) shown = bit ? (shown | (1 << i)) : (shown & ~(1 << i));
  }
  return fileDi | shown;
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
/// Như board khởi động lại: chạy lại chính gw-sim.exe (cùng tham số, biến môi trường, cửa sổ) rồi thoát tiến trình cũ.
void EspClass::restart() {
  printf("[sim] ESP.restart() — chạy lại gw-sim.exe\n"); fflush(stdout);
  STARTUPINFOA si = {}; si.cb = sizeof si; PROCESS_INFORMATION pi = {};
  std::string cmd = GetCommandLineA();
  char pid[16]; snprintf(pid, sizeof pid, "%lu", GetCurrentProcessId());
  SetEnvironmentVariableA("SIM_WAIT_PID", pid);   // tiến trình mới chờ tiến trình này thoát hẳn rồi mới mở cổng (không thì "cổng đang dùng")
  if (CreateProcessA(nullptr, &cmd[0], nullptr, nullptr, TRUE, 0, nullptr, nullptr, &si, &pi)) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
  else printf("[sim] không chạy lại được (%lu) — mở lại tay\n", GetLastError());
  exit(0);
}

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
bool EthClass::config(IPAddress ip, IPAddress gw, IPAddress mask, IPAddress) {
  printf("[sim] ETH.config: board thật sẽ dùng IP %s/%s gw %s — bản giả lập vẫn dùng IP của PC %s\n",
         ip.toString().c_str(), mask.toString().c_str(), gw.toString().c_str(), localIP().toString().c_str());
  return true;
}
IPAddress EthClass::subnetMask() { return IPAddress(255, 255, 255, 0); }
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

// ---------------------------------------------------------------- TCP client / server
NetworkClient::NetworkClient(SOCKET s) : h_(std::make_shared<Holder>()) { h_->s = s; u_long nb = 1; ioctlsocket(s, FIONBIO, &nb); }
int NetworkClient::connect(const char* host, int port, int timeoutMs) {
  stop();
  addrinfo hints = {}, *res = nullptr; hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;
  char ps[8]; snprintf(ps, sizeof ps, "%d", port);
  if (getaddrinfo(host, ps, &hints, &res) != 0) return 0;
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  SetHandleInformation((HANDLE)s, HANDLE_FLAG_INHERIT, 0);   // ESP.restart() chạy lại chương trình: tiến trình mới không được thừa kế socket
  u_long nb = 1; ioctlsocket(s, FIONBIO, &nb);
  ::connect(s, res->ai_addr, (int)res->ai_addrlen);
  freeaddrinfo(res);
  fd_set w; FD_ZERO(&w); FD_SET(s, &w);
  timeval tv = {timeoutMs / 1000, (timeoutMs % 1000) * 1000};
  int err = 0; int len = sizeof err;
  if (select(0, nullptr, &w, nullptr, &tv) <= 0 || (getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&err, &len), err)) { closesocket(s); return 0; }
  h_ = std::make_shared<Holder>(); h_->s = s;
  return 1;
}
bool NetworkClient::connected() {
  SOCKET s = sock();
  if (s == INVALID_SOCKET) return false;
  char c; int r = recv(s, &c, 1, MSG_PEEK);
  if (r == 0) return false;
  if (r < 0 && WSAGetLastError() != WSAEWOULDBLOCK) return false;
  return true;
}
void NetworkClient::stop() { if (h_ && h_->s != INVALID_SOCKET) { closesocket(h_->s); h_->s = INVALID_SOCKET; } h_.reset(); }
void NetworkClient::setNoDelay(bool on) { int v = on; if (sock() != INVALID_SOCKET) setsockopt(sock(), IPPROTO_TCP, TCP_NODELAY, (char*)&v, sizeof v); }
int NetworkClient::available() { u_long n = 0; if (sock() == INVALID_SOCKET || ioctlsocket(sock(), FIONREAD, &n) != 0) return 0; return (int)n; }
int NetworkClient::read() { uint8_t c; return sock() != INVALID_SOCKET && recv(sock(), (char*)&c, 1, 0) == 1 ? c : -1; }
int NetworkClient::read(uint8_t* buf, size_t n) { if (sock() == INVALID_SOCKET) return -1; int r = recv(sock(), (char*)buf, (int)n, 0); return r > 0 ? r : (r < 0 && WSAGetLastError() == WSAEWOULDBLOCK ? 0 : -1); }
size_t NetworkClient::write(const uint8_t* p, size_t n) {
  size_t k = 0; uint32_t t0 = millis();
  while (k < n && sock() != INVALID_SOCKET && millis() - t0 < 2000) {
    int r = send(sock(), (const char*)p + k, (int)(n - k), 0);
    if (r > 0) k += r; else if (WSAGetLastError() == WSAEWOULDBLOCK) Sleep(1); else break;
  }
  return k;
}
IPAddress NetworkClient::remoteIP() const {
  sockaddr_in a = {}; int l = sizeof a;
  if (sock() == INVALID_SOCKET || getpeername(sock(), (sockaddr*)&a, &l) != 0) return IPAddress();
  const uint8_t* b = (const uint8_t*)&a.sin_addr; return IPAddress(b[0], b[1], b[2], b[3]);
}

void NetworkServer::begin() {
  ls_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  SetHandleInformation((HANDLE)ls_, HANDLE_FLAG_INHERIT, 0);   // ESP.restart() chạy lại chương trình: tiến trình mới không được thừa kế socket
  sockaddr_in a = {}; a.sin_family = AF_INET; a.sin_port = htons((u_short)port_); a.sin_addr.s_addr = INADDR_ANY;
  if (bind(ls_, (sockaddr*)&a, sizeof a) != 0 || listen(ls_, 8) != 0) { printf("[sim] KHÔNG mở được cổng %d (đang có chương trình khác dùng? đặt SIM_API_PORT)\n", port_); closesocket(ls_); ls_ = INVALID_SOCKET; return; }
  u_long nb = 1; ioctlsocket(ls_, FIONBIO, &nb);
}
NetworkClient NetworkServer::accept() {
  if (ls_ == INVALID_SOCKET) return NetworkClient();
  SOCKET s = ::accept(ls_, nullptr, nullptr);
  return s == INVALID_SOCKET ? NetworkClient() : NetworkClient(s);
}

uint32_t simPairWaitMs() { const char* p = getenv("SIM_PAIR_WAIT_SEC"); return (uint32_t)(p && atoi(p) > 0 ? atoi(p) : 24 * 3600) * 1000u; }
int simSetupWindowMs() { const char* p = getenv("SIM_WINDOW_SEC"); return (p && atoi(p) > 0 ? atoi(p) : 600) * 1000; }

// ---------------------------------------------------------------- UDP
bool NetworkUDP::begin(int port) {
  s_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  SetHandleInformation((HANDLE)s_, HANDLE_FLAG_INHERIT, 0);   // ESP.restart() chạy lại chương trình: tiến trình mới không được thừa kế socket
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

#endif  // GW_SIM
