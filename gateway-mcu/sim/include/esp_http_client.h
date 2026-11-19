#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// esp_http_client tối giản cho bản giả lập: đúng các kiểu/hàm firmware (cloud.cpp) dùng; HTTPS qua NetworkClientSecure (mbedtls).
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
const char* esp_err_to_name(esp_err_t e);
typedef enum { HTTP_METHOD_GET, HTTP_METHOD_POST } esp_http_client_method_t;
typedef enum { HTTP_EVENT_ERROR, HTTP_EVENT_ON_CONNECTED, HTTP_EVENT_ON_HEADER, HTTP_EVENT_ON_DATA, HTTP_EVENT_ON_FINISH, HTTP_EVENT_DISCONNECTED } esp_http_client_event_id_t;
struct esp_http_client;
typedef struct esp_http_client* esp_http_client_handle_t;
typedef struct {
  esp_http_client_event_id_t event_id;
  esp_http_client_handle_t client;
  void* data; int data_len;
  void* user_data;
  char* header_key; char* header_value;
} esp_http_client_event_t;
typedef esp_err_t (*http_event_handle_cb)(esp_http_client_event_t* evt);
typedef struct {
  const char* url = nullptr;
  esp_http_client_method_t method = HTTP_METHOD_GET;
  int timeout_ms = 5000;
  esp_err_t (*crt_bundle_attach)(void* conf) = nullptr;
  http_event_handle_cb event_handler = nullptr;
  void* user_data = nullptr;
} esp_http_client_config_t;
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t* config);
esp_err_t esp_http_client_set_header(esp_http_client_handle_t client, const char* key, const char* value);
esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t client, const char* data, int len);
esp_err_t esp_http_client_perform(esp_http_client_handle_t client);
int esp_http_client_get_status_code(esp_http_client_handle_t client);
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t client);
