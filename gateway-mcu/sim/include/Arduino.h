#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
// Lớp "giả Arduino" để biên dịch CHÍNH mã firmware (gateway-mcu/src) thành chương trình Windows — thử với GatewayApp không cần board.
// Chỉ có đúng phần API firmware dùng. Thread/khoá dùng Win32 trực tiếp (MinGW.org không có std::thread).
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <cmath>
#include <cstdarg>
#include <string>
#include <algorithm>
#include <functional>
#include <vector>
#include <map>
#undef min
#undef max
using std::min;
using std::max;

#define HEX 16
#define DEC 10

class String {
 public:
  std::string s;
  String() {}
  String(const char* c) : s(c ? c : "") {}
  String(const char* c, size_t n) : s(c, n) {}
  String(const std::string& x) : s(x) {}
  String(char c) : s(1, c) {}
  String(int v, int base = DEC) { fmt((long long)v, base); }
  String(unsigned v, int base = DEC) { fmtu((unsigned long long)v, base); }
  String(long v, int base = DEC) { fmt((long long)v, base); }
  String(unsigned long v, int base = DEC) { fmtu((unsigned long long)v, base); }
  String(long long v, int base = DEC) { fmt(v, base); }
  String(unsigned long long v, int base = DEC) { fmtu(v, base); }
  String(double v, int dec = 2) { char b[64]; snprintf(b, sizeof b, "%.*f", dec, v); s = b; }
  const char* c_str() const { return s.c_str(); }
  unsigned length() const { return (unsigned)s.size(); }
  void reserve(size_t n) { s.reserve(n); }
  bool concat(const char* c) { if (c) s += c; return true; }
  bool concat(const char* c, size_t n) { s.append(c, n); return true; }
  bool concat(const String& o) { s += o.s; return true; }
  bool concat(char c) { s += c; return true; }
  String& operator+=(const String& o) { s += o.s; return *this; }
  String& operator+=(const char* c) { if (c) s += c; return *this; }
  String& operator+=(char c) { s += c; return *this; }
  char operator[](size_t i) const { return i < s.size() ? s[i] : 0; }
  char& operator[](size_t i) { return s[i]; }
  bool operator==(const String& o) const { return s == o.s; }
  bool operator==(const char* c) const { return s == (c ? c : ""); }
  bool operator!=(const String& o) const { return s != o.s; }
  bool operator!=(const char* c) const { return !(*this == c); }
  bool operator<(const String& o) const { return s < o.s; }
  bool operator>(const String& o) const { return s > o.s; }
  int indexOf(char c, unsigned from = 0) const { auto p = s.find(c, from); return p == std::string::npos ? -1 : (int)p; }
  int indexOf(const String& x, unsigned from = 0) const { auto p = s.find(x.s, from); return p == std::string::npos ? -1 : (int)p; }
  int lastIndexOf(char c) const { auto p = s.rfind(c); return p == std::string::npos ? -1 : (int)p; }
  int lastIndexOf(const String& x) const { auto p = s.rfind(x.s); return p == std::string::npos ? -1 : (int)p; }
  String substring(unsigned a) const { return a >= s.size() ? String() : String(s.substr(a)); }
  String substring(unsigned a, unsigned b) const { if (b > s.size()) b = (unsigned)s.size(); return a >= b ? String() : String(s.substr(a, b - a)); }
  bool startsWith(const String& x) const { return s.compare(0, x.s.size(), x.s) == 0 && s.size() >= x.s.size(); }
  bool endsWith(const String& x) const { return s.size() >= x.s.size() && s.compare(s.size() - x.s.size(), x.s.size(), x.s) == 0; }
  void replace(char a, char b) { std::replace(s.begin(), s.end(), a, b); }
  void replace(const String& a, const String& b) {
    if (a.s.empty()) return;
    size_t p = 0; while ((p = s.find(a.s, p)) != std::string::npos) { s.replace(p, a.s.size(), b.s); p += b.s.size(); }
  }
  void remove(unsigned i) { if (i < s.size()) s.erase(i); }
  void remove(unsigned i, unsigned n) { if (i < s.size()) s.erase(i, n); }
  void trim() { size_t a = s.find_first_not_of(" \t\r\n"); if (a == std::string::npos) { s.clear(); return; } size_t b = s.find_last_not_of(" \t\r\n"); s = s.substr(a, b - a + 1); }
  void toLowerCase() { for (auto& c : s) c = (char)tolower((unsigned char)c); }
  void toUpperCase() { for (auto& c : s) c = (char)toupper((unsigned char)c); }
  long toInt() const { return strtol(s.c_str(), nullptr, 10); }
  bool equalsIgnoreCase(const String& o) const { if (s.size() != o.s.size()) return false; for (size_t i = 0; i < s.size(); i++) if (tolower((unsigned char)s[i]) != tolower((unsigned char)o.s[i])) return false; return true; }
  std::string::const_iterator begin() const { return s.begin(); }
  std::string::const_iterator end() const { return s.end(); }
 private:
  void fmt(long long v, int base) { if (base == 16) { char b[32]; snprintf(b, sizeof b, "%llx", (unsigned long long)v); s = b; } else { char b[32]; snprintf(b, sizeof b, "%lld", v); s = b; } }
  void fmtu(unsigned long long v, int base) { char b[32]; snprintf(b, sizeof b, base == 16 ? "%llx" : "%llu", v); s = b; }
};
inline String operator+(const String& a, const String& b) { String r(a); r += b; return r; }
inline String operator+(const String& a, const char* b) { String r(a); r += b; return r; }
inline String operator+(const char* a, const String& b) { String r(a); r += b; return r; }
inline String operator+(const String& a, char b) { String r(a); r += b; return r; }
inline bool operator==(const char* a, const String& b) { return b == a; }

// ---- Print / Stream (ArduinoJson đọc/ghi File qua đây)
class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t c) = 0;
  virtual size_t write(const uint8_t* p, size_t n) { size_t k = 0; while (n--) k += write(*p++); return k; }
  size_t print(const String& x) { return write((const uint8_t*)x.c_str(), x.length()); }
  size_t print(const char* x) { return write((const uint8_t*)x, strlen(x)); }
  size_t print(char c) { return write((uint8_t)c); }
  size_t print(unsigned long v) { char b[24]; snprintf(b, sizeof b, "%lu", v); return print(b); }
  size_t printf(const char* f, ...) { char b[1024]; va_list ap; va_start(ap, f); int n = vsnprintf(b, sizeof b, f, ap); va_end(ap); return n > 0 ? write((const uint8_t*)b, (size_t)min(n, (int)sizeof b - 1)) : 0; }
};
class Printable { public: virtual ~Printable() {} virtual size_t printTo(Print& p) const = 0; };
class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
  virtual size_t readBytes(char* buf, size_t n) { size_t k = 0; while (k < n) { int c = read(); if (c < 0) break; buf[k++] = (char)c; } return k; }
  String readStringUntil(char t) { String r; for (;;) { int c = read(); if (c < 0 || c == t) break; r += (char)c; } return r; }
  long parseInt() { String r; int c; while ((c = peek()) >= 0 && !isdigit(c) && c != '-') read(); while ((c = peek()) >= 0 && (isdigit(c) || c == '-')) { r += (char)c; read(); } return r.toInt(); }
};

class SerialPort : public Print {
 public:
  void begin(unsigned long) { SetConsoleOutputCP(65001); }
  size_t write(uint8_t c) override { fputc(c, stdout); return 1; }
  size_t write(const uint8_t* p, size_t n) override { fwrite(p, 1, n, stdout); fflush(stdout); return n; }
};
extern SerialPort Serial;

// ---- thời gian / GPIO giả
inline uint32_t millis() { return (uint32_t)GetTickCount(); }
inline void delay(uint32_t ms) { Sleep(ms); }
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define HIGH 1
#define LOW 0
void pinMode(int, int);
int digitalRead(int pin);
void digitalWrite(int, int);
void rgbLedWrite(int, uint8_t, uint8_t, uint8_t);
template <class T> T constrain(T x, T a, T b) { return x < a ? a : x > b ? b : x; }

struct EspClass { uint64_t getEfuseMac(); void restart(); };
extern EspClass ESP;

class IPAddress {
 public:
  uint8_t b[4] = {0, 0, 0, 0};
  IPAddress() {}
  IPAddress(uint8_t a, uint8_t c, uint8_t d, uint8_t e) { b[0] = a; b[1] = c; b[2] = d; b[3] = e; }
  uint8_t operator[](int i) const { return b[i]; }
  bool operator==(const IPAddress& o) const { return memcmp(b, o.b, 4) == 0; }
  bool operator!=(const IPAddress& o) const { return !(*this == o); }
  String toString() const { char s[20]; snprintf(s, sizeof s, "%u.%u.%u.%u", b[0], b[1], b[2], b[3]); return String(s); }
};

// ---- FreeRTOS giả (Win32)
typedef void* SemaphoreHandle_t;
typedef void* TaskHandle_t;
typedef uint32_t TickType_t;
#define portMAX_DELAY 0xFFFFFFFFu
#define pdTRUE 1
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex();
int xSemaphoreTakeRecursive(SemaphoreHandle_t, TickType_t);
int xSemaphoreGiveRecursive(SemaphoreHandle_t);
int xTaskCreatePinnedToCore(void (*fn)(void*), const char*, uint32_t, void*, int, TaskHandle_t*, int);
uint32_t ulTaskNotifyTake(int, TickType_t);
void xTaskNotifyGive(TaskHandle_t);

// ---- UART (RS485): mở COM thật nếu đặt SIM_COM=COM5 (bộ chuyển USB-RS485), không thì như bus không có slave (hết giờ chờ)
#define SERIAL_8N1 0x1
#define SERIAL_8E1 0x2
#define SERIAL_8O1 0x3
class HardwareSerial {
 public:
  void begin(unsigned long baud, uint32_t mode, int rx, int tx);
  void end();
  void setPins(int, int, int, int) {}
  void setMode(int) {}
  int available();
  int read();
  size_t write(const uint8_t* p, size_t n);
  void flush() {}
 private:
  HANDLE h_ = INVALID_HANDLE_VALUE;
  uint8_t buf_[512]; int len_ = 0, pos_ = 0;
};
extern HardwareSerial Serial1;

// ---- thời gian (cloud.cpp): đồng hồ Windows luôn đúng nên NTP/đặt giờ là no-op
#include <ctime>
#include <sys/time.h>
inline void configTime(long, int, const char*, const char* = nullptr) {}
inline int settimeofday(const struct timeval*, const void*) { return 0; }
inline void yield() { Sleep(0); }                         // PubSubClient
#define PROGMEM
#define pgm_read_byte_near(p) (*(const uint8_t*)(p))

// ---- sim
int simApiPort();
int simSetupWindowMs();
uint32_t simPairWaitMs();
int simStatusPort();
const char* simDataDir();
