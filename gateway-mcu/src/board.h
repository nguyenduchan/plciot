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
#define DO_ACTIVE_HIGH 0     // 0: bản output transistor (8DO) — EXIO thấp = đầu ra BẬT (LED sáng); ghi 1 = tắt. Quan sát trên board thật 2026-11: với 1 thì cả 8 LED sáng khi tắt. Bản relay (8RO) thì đặt 1.

#define PIN_RGB    38        // LED RGB (WS2812)
#define PIN_BUZZER 46
#define PIN_BOOT   0         // nút BOOT: nhấn ngắn = mở cho admin 10 phút; giữ 10 giây = xoá cấu hình

#ifdef GW_SIM
#define MBS_PORT simMbsPort()        // Modbus TCP slave (chế độ gateway): SIM_MBS_PORT (mặc định 502)
#define API_PORT simApiPort()        // bản giả lập trên PC: SIM_API_PORT (mặc định 443 như board)
#define STATUS_PORT simStatusPort()  // SIM_HTTP_PORT (mặc định 80)
#else
#define MBS_PORT 502         // Modbus TCP slave — chỉ nhận kết nối từ PC đang giữ lease (xem slave.cpp)
#define API_PORT 443         // API cài đặt qua HTTPS (chứng chỉ từ khoá danh tính, GatewayApp ghim khoá)
#define STATUS_PORT 80       // trang trạng thái HTTP thường như thiết bị Ethernet sẵn firmware Waveshare — KHÔNG nhận lệnh cấu hình
#endif
#define DISCOVER_PORT 8751   // RemoteClient.DiscoverPort
#ifdef GW_SIM
#define SETUP_WINDOW_MS simSetupWindowMs()   // bản giả lập: rút ngắn bằng SIM_WINDOW_SEC để thử "hết cửa sổ ghép"
#define PAIR_WAIT_MS simPairWaitMs()         // SIM_PAIR_WAIT_SEC: rút ngắn 24 giờ chờ để thử tự kích hoạt
#else
#define SETUP_WINDOW_MS (10 * 60 * 1000UL)   // cửa sổ ghép PC admin mới: 10 phút sau khi nhấn BOOT (hoặc cấp điện khi chưa có PC nào)
#define PAIR_WAIT_MS (24UL * 3600 * 1000)    // PC mới ghép khi đã có PC quản trị: chờ 24 giờ (thời gian board có điện) nếu không ai từ chối
#endif

// Mạng mặc định — theo quy ước thiết bị Ethernet công nghiệp có sẵn firmware của Waveshare: IP TĨNH 192.168.1.200/24.
// Đổi bằng GatewayApp (cửa sổ Waveshare → "Mạng (IP)…") hoặc API PUT /api/network; giữ BOOT 10 giây = về mặc định.
#define NET_DEFAULT_IP   "192.168.1.200"
#define NET_DEFAULT_MASK "255.255.255.0"
#define NET_DEFAULT_GW   "192.168.1.1"
#define NET_DEFAULT_DNS  "8.8.8.8"
