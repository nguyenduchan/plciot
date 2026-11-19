// Cấu hình mbedtls cho bản giả lập trên PC (MBEDTLS_USER_CONFIG_FILE, chỉ build-sim.ps1 dùng). Board dùng mbedtls của ESP-IDF, không đọc file này.
#ifndef GW_SIM
#error "sim_mbedtls_config.h chi dung cho ban gia lap tren PC (-DGW_SIM)"
#endif
#undef MBEDTLS_AESNI_C            // MinGW 32-bit cũ: tránh intrinsic/asm x86
#undef MBEDTLS_PADLOCK_C
#undef MBEDTLS_HAVE_ASM
#undef MBEDTLS_NET_C              // socket do lớp giả (sim/tls_sim.cpp) tự lo
#define MBEDTLS_NO_PLATFORM_ENTROPY      // headers MinGW.org không có BCryptGenRandom …
#define MBEDTLS_ENTROPY_HARDWARE_ALT     // … nên lấy ngẫu nhiên qua mbedtls_hardware_poll() = RtlGenRandom (sim/tls_sim.cpp)
#define MBEDTLS_PLATFORM_GMTIME_R_ALT    // MinGW.org không có gmtime_s
