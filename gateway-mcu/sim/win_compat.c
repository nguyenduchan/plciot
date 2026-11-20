/* Hàm Windows mà mbedtls gọi nhưng thư viện liên kết của MinGW.org (GCC 6.3) không có. Chỉ cho bản giả lập (-DGW_SIM). */
#ifdef GW_SIM
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

/* winnt.h bản mới là hàm inline; MinGW.org để là hàm ngoài → tự viết (xoá bằng con trỏ volatile để trình biên dịch không bỏ qua) */
void* SecureZeroMemory(void* p, size_t n) {
  volatile unsigned char* v = (volatile unsigned char*)p;
  while (n--) *v++ = 0;
  return p;
}

/* mbedtls dùng để so địa chỉ IP trong SAN của chứng chỉ. Chỉ cần IPv4 (broker/server của dự án); IPv6 → 0 = không phải địa chỉ hợp lệ. */
#ifdef __MINGW64_VERSION_MAJOR
__attribute__((weak))   /* mingw-w64 mới đã có inet_pton: bản này chỉ là dự phòng */
#endif
int inet_pton(int af, const char* src, void* dst) {
  if (af != 2 /* AF_INET */) return 0;
  unsigned char out[4]; int part = 0; unsigned v = 0; int digits = 0;
  for (const char* c = src;; c++) {
    if (*c >= '0' && *c <= '9') { v = v * 10 + (unsigned)(*c - '0'); if (v > 255 || ++digits > 3) return 0; }
    else if (*c == '.' || *c == 0) {
      if (!digits || part > 3) return 0;
      out[part++] = (unsigned char)v; v = 0; digits = 0;
      if (*c == 0) break;
    } else return 0;
  }
  if (part != 4) return 0;
  memcpy(dst, out, 4);
  return 1;
}
#endif /* GW_SIM */
