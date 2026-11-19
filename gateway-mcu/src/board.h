#pragma once
// Chân của Waveshare ESP32-S3-POE-ETH-8DI-8DO, theo bảng "Interfaces" trên wiki
// https://www.waveshare.com/wiki/ESP32-S3-POE-ETH-8DI-8DO (đọc 2026-11).
// HAI ĐIỂM WIKI CHƯA NÓI RÕ — kiểm lại trên board thật / sơ đồ nguyên lý trước khi đấu tải:
//   1. TCA9554 (DO1..DO8) nằm trên bus I2C nào: giả định chung bus với RTC (SDA 42, SCL 41).
//   2. Mức tích cực của DI và DO (DI_ACTIVE_LOW, DO_ACTIVE_HIGH bên dưới).

// W5500 (SPI)
#define ETH_SCLK 15
#define ETH_MOSI 13
#define ETH_MISO 14
#define ETH_CS   16
#define ETH_INT  12
#define ETH_RST  39

// RS485 (UART1). RTS = chân hướng truyền, UART tự đảo ở chế độ RS485 half-duplex.
#define RS485_TX  17
#define RS485_RX  18
#define RS485_RTS 21

// DI1..DI8 (cách ly quang)
static const int DI_PINS[8] = {4, 5, 6, 7, 8, 9, 10, 11};
#define DI_ACTIVE_LOW 1      // 1: có tín hiệu → GPIO mức thấp (thường gặp với opto kéo xuống). Sai thì đổi 0.

// DO1..DO8 qua TCA9554 (EXIO1..EXIO8)
#define I2C_SDA 42
#define I2C_SCL 41
#define TCA9554_ADDR 0x20
#define DO_ACTIVE_HIGH 1     // 1: ghi 1 ra EXIO = bật đầu ra.

#define PIN_RGB    38        // LED RGB (WS2812)
#define PIN_BUZZER 46
#define PIN_BOOT   0         // nút BOOT: nhấn ngắn = mở cho admin 10 phút; giữ 10 giây = xoá cấu hình

#ifdef GW_SIM
#define API_PORT simApiPort()  // bản giả lập trên PC: đổi cổng bằng biến môi trường SIM_API_PORT (tránh trùng GatewayApp)
#else
#define API_PORT 8750        // giống gateway PC (MainForm.Remote.cs)
#endif
#define DISCOVER_PORT 8751   // RemoteClient.DiscoverPort
