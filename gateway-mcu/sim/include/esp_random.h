#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// Ngẫu nhiên mật mã của Windows (RtlGenRandom = advapi32!SystemFunction036, nạp động vì MinGW.org không có trong thư viện liên kết).
// Khoá ECDSA và mã kết nối của bản giả lập sinh từ đây.
inline void esp_fill_random(void* p, size_t n) {
  typedef BOOLEAN(WINAPI * GenRandom)(PVOID, ULONG);
  static GenRandom f = (GenRandom)GetProcAddress(LoadLibraryA("advapi32.dll"), "SystemFunction036");
  if (!f || !f(p, (ULONG)n)) { fprintf(stderr, "[sim] RtlGenRandom lỗi — dừng (không sinh khoá yếu)\n"); exit(1); }
}
inline uint32_t esp_random() { uint32_t v; esp_fill_random(&v, 4); return v; }
