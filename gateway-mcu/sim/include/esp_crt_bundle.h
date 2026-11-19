#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <esp_http_client.h>
// Bản giả lập: "bộ CA của ESP-IDF" = kho chứng chỉ gốc của Windows (nạp trong sim/tls_sim.cpp).
esp_err_t esp_crt_bundle_attach(void* conf);
