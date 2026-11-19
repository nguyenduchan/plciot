#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// LittleFS giả: file nằm trong thư mục dữ liệu của bản giả lập (SIM_DATA, mặc định .\simdata).
class File : public Stream {
 public:
  File() {}
  File(FILE* f) : f_(f) {}
  explicit operator bool() const { return f_ != nullptr; }
  size_t write(uint8_t c) override { return f_ && fputc(c, f_) != EOF ? 1 : 0; }
  size_t write(const uint8_t* p, size_t n) override { return f_ ? fwrite(p, 1, n, f_) : 0; }
  int available() override { if (!f_) return 0; long p = ftell(f_); return (int)(size() - p); }
  int read() override { return f_ ? fgetc(f_) : -1; }
  int peek() override { if (!f_) return -1; int c = fgetc(f_); if (c != EOF) ungetc(c, f_); return c; }
  size_t readBytes(char* b, size_t n) override { return f_ ? fread(b, 1, n, f_) : 0; }
  size_t size() const { if (!f_) return 0; long p = ftell(f_); fseek(f_, 0, SEEK_END); long n = ftell(f_); fseek(f_, p, SEEK_SET); return (size_t)n; }
  bool seek(size_t pos) { return f_ && fseek(f_, (long)pos, SEEK_SET) == 0; }
  size_t position() const { return f_ ? (size_t)ftell(f_) : 0; }
  void close() { if (f_) fclose(f_); f_ = nullptr; }
 private:
  FILE* f_ = nullptr;
};

class FsClass {
 public:
  bool begin(bool) { return true; }
  File open(const char* path, const char* mode);
  File open(const String& path, const char* mode) { return open(path.c_str(), mode); }
  bool exists(const char* path);
  bool exists(const String& p) { return exists(p.c_str()); }
  bool remove(const char* path);
  bool remove(const String& p) { return remove(p.c_str()); }
  bool rename(const char* a, const char* b);
};
extern FsClass LittleFS;
