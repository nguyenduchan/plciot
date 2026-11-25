#pragma once
// Khai báo chung của firmware gateway MCU. Mô hình giống gateway PC (scada/src/Plciot.Scada.Core):
//   cấu hình = ApiConfig {Config: ScadaConfig, Fields, Devices} do GatewayApp đẩy qua LAN (PUT /api/config);
//   mỗi field của Pack = d.<child>.<khoá MQTT> = giải mã(kiểu, thứ tự word, word từ D) / hệ số.
// Board chỉ chạy 2 giao thức: Modbus RTU (RS485 trên board) và Modbus TCP (qua cổng Ethernet).
// Modbus RTU với Unit ID 0 (địa chỉ broadcast, không slave thật nào trả lời) = I/O TRÊN BOARD:
//   D0 = DI1..DI8 (bit 0 = DI1, chỉ đọc), D1 = DO1..DO8 (ghi được), D10..D17 = DI1..DI8 (0/1), D20..D27 = DO1..DO8 (0/1, ghi được).
//   DI đã LỌC RUNG (mức đổi khi ổn định ≥ difilter ms). Bộ đếm cạnh lên của DI: D30..D37 (16 bit, vòng 65535→0), D40..D55 (32 bit, DIn = D40+2(n-1) word cao trước);
//   ghi vào bộ đếm = đặt lại giá trị (thường ghi 0).
// GW_SIM = bản giả lập trên PC (gateway-mcu/sim, build-sim.ps1). Bản nạp xuống board KHÔNG BAO GIỜ có cờ này.
#if defined(GW_SIM) && defined(ESP_PLATFORM)
#error "GW_SIM chi dung cho ban gia lap tren PC - bo -DGW_SIM khoi build_flags truoc khi nap xuong board"
#endif
#include <Arduino.h>
#include <ArduinoJson.h>
#include <vector>
#include <map>

#ifndef FW_VERSION
#ifdef GW_SIM
#define FW_VERSION "mcu-sim"
#else
#define FW_VERSION "mcu-dev"
#endif
#endif

enum class Proto : uint8_t { None, ModbusTcp, ModbusRtu, Other };
enum class Access : uint8_t { Read, Write, ReadWrite };
enum class DType : uint8_t { UInt16, Int16, Bool, UInt32, Int32, Float32, Float64 };

struct Field {
  String child, field, wire, protocol;
  int addr = 0; double scale = 1;
  bool hasMin = false, hasMax = false; double min = 0, max = 0;
  Proto proto = Proto::None; Access access = Access::ReadWrite; DType type = DType::UInt16;
  bool swap = false, enabled = true; int unit = 1;
  uint32_t minToggleMs = 0;          // đầu ra số: ms tối thiểu giữa hai lần ĐỔI trạng thái (PackMap.MinToggleMs), 0 = không giới hạn
  uint32_t lossOffSec = 0;           // DO board: mất người điều khiển quá ngần này giây → tự TẮT (PackMap.LossOffSec), 0 = giữ nguyên
  int words() const { return type == DType::Float64 ? 4 : (type == DType::UInt32 || type == DType::Int32 || type == DType::Float32) ? 2 : 1; }
  bool localIo() const { return proto == Proto::ModbusRtu && unit == 0; }
};

struct Conn { bool has = false; String host; int port = 0; String parity = "Even"; int diFilterMs = 20; };   // diFilterMs: lọc rung DI của board (tuỳ chọn "difilter" của kết nối Modbus RTU, 0 = tắt)

struct Cfg {
  String site = "factory1", device = "plc01", mqttId, solution;
  int pollMs = 1000;
  String mobile = "Off";             // Off | MonitorOnly | Control (ScadaConfig.Mobile)
  String cloudHost, cloudTransport = "mqtts", cloudUser = "gw", cloudPin, cmdKey, apiUrl, qr;
  int cloudPort = 48263;
  bool sendData = true;
  int teleMinMs = 1000, idleMs = 0, cmdMaxAgeSec = 10, remoteCmdPerSec = 5;
  int retentionDays = 1, histIntervalSec = 10;   // gửi bù dữ liệu offline: thời hạn lưu của gói cloud, chu kỳ một mẫu
  Conn rtu, tcp;
  std::vector<Field> pack;
  bool cloudOn() const { return mobile != "Off"; }
  bool remoteControl() const { return mobile == "Control"; }
};

// ---------------------------------------------------------------- store.cpp: cấu hình (LittleFS) + bí mật (NVS)
extern Cfg g_cfg;
extern JsonDocument g_raw;            // ApiConfig đúng như admin gửi (để trả lại nguyên vẹn, kể cả trường board không dùng)
extern int g_rev;                     // tăng mỗi lần cấu hình đổi: admin thấy đổi thì tải lại
extern SemaphoreHandle_t g_lock;      // khoá chung: cấu hình + giá trị + bus
struct Lock { Lock() { xSemaphoreTakeRecursive(g_lock, portMAX_DELAY); } ~Lock() { xSemaphoreGiveRecursive(g_lock); } };
// Khoá bus (RS485/TCP tới PLC): giữ trong lúc trao đổi với thiết bị chậm, KHÔNG giữ g_lock lúc đó (API trạng thái không bị treo).
// Thứ tự luôn là BusLock trước rồi mới Lock.
extern SemaphoreHandle_t g_bus;
struct BusLock { BusLock() { xSemaphoreTakeRecursive(g_bus, portMAX_DELAY); } ~BusLock() { xSemaphoreGiveRecursive(g_bus); } };
/// BusLock chỉ khi cần (on = false: không khoá). I/O trên board (Unit 0) KHÔNG đi qua bus RS485/TCP → không chờ PLC chậm, dùng IoLock.
struct BusLockIf { bool on; explicit BusLockIf(bool o) : on(o) { if (on) xSemaphoreTakeRecursive(g_bus, portMAX_DELAY); } ~BusLockIf() { if (on) xSemaphoreGiveRecursive(g_bus); } };
// Khoá I/O trên board: bus I2C (TCA9554 + RTC dùng chung) + trạng thái DO. Giữ rất ngắn (một giao dịch I2C ~1 ms, Wire có timeout).
// Có thể lấy khi đang giữ BusLock/Lock; ngược lại KHÔNG lấy BusLock/Lock khi đang giữ IoLock.
extern SemaphoreHandle_t g_io;
struct IoLock { IoLock() { xSemaphoreTakeRecursive(g_io, portMAX_DELAY); } ~IoLock() { xSemaphoreGiveRecursive(g_io); } };
/// CHẾ ĐỘ KHOÁ (thiết bị báo mất trộm, admin khoá theo mã phần cứng trên server): dừng đọc/điều khiển PLC, từ chối mọi đăng nhập và ghép PC
/// (kể cả nút BOOT), ngừng gửi dữ liệu. Lưu NVS "lock" — reset bằng BOOT KHÔNG xoá được; chỉ server mở (sys:unlock có chữ ký / hết bị chặn).
extern bool g_locked;
extern String g_lockReason;
void setLocked(bool on, const String& reason);
void storeBegin();
String storeValidate(JsonObjectConst cfg);       // "" = hợp lệ, ngược lại câu báo lỗi (tiếng Việt, hiện trên GatewayApp)
void storeApply();                               // g_raw → g_cfg
bool storeSave();                                // g_raw → /config.json (mật khẩu cloud tách ra NVS)
void storeReset();                               // xoá cấu hình (giữ khoá danh tính + mã kết nối)
String secretGet(const char* key);
void secretSet(const char* key, const String& v);
String cloudPassword();
void setCloudPassword(const String& v);
String configMessage();                          // bản tin <base>/config (ConfigBuilder.cs)
/// Nhãn/đơn vị/ngưỡng hiển thị của field (MetaDescriber của GatewayApp): ngưỡng chỉ có với kiểu bồn/đồng hồ.
struct FieldLook { String devTitle, label, unit; bool hasLow = false, hasHigh = false; double low = 0, high = 0; };
FieldLook fieldLook(const Field& f);

// ---------------------------------------------------------------- net.cpp: cấu hình IP (NVS, tách khỏi ApiConfig — admin đẩy cấu hình thiết bị không đụng tới)
struct NetCfg { bool dhcp = false; String ip, mask, gw, dns; };
NetCfg netLoad();
String netValidate(const NetCfg& n);             // "" = hợp lệ
void netSave(const NetCfg& n);
void netReset();                                 // về mặc định 192.168.1.200/24
void netApply();                                 // gọi sau ETH.begin(): IP tĩnh → ETH.config, DHCP → để nguyên
// wifi.cpp: Wi-Fi station song song với Ethernet (cấu hình qua LAN: API /api/wifi*)
void wifiBegin();
void wifiLoop();
void serialCfgLoop();                            // serialcfg.cpp: cài Wi-Fi qua cáp USB (dòng JSON, trả "@@{…}")                                 // gọi trong loop(): bật/tắt hotspot cài đặt tuỳ có dây / có Wi-Fi hay không
bool netEthUp();                                 // Ethernet đã cắm dây và có IP
String wifiScanJson();                           // [{Ssid,Rssi,Open}]
String wifiStatusJson();                         // {Supported,Saved,Connected,Ssid,Rssi,Ip,Mac} — không có mật khẩu
bool wifiConnect(const String& ssid, const String& pass, String& err);   // nối thử rồi mới lưu; ssid rỗng = quên mạng
// Địa chỉ đang dùng: Ethernet nếu có IP, không thì Wi-Fi (board chỉ có Wi-Fi vẫn cài đặt/chạy cloud như khi cắm dây).
IPAddress netIp();
bool netUp();
IPAddress netIpFor(const IPAddress& peer);       // IP của giao diện cùng mạng con với peer (Wi-Fi hay Ethernet) — cho gói tìm thiết bị
String netMaskFor(const IPAddress& peer);
String netMask();                                // subnet đang dùng (cho gói tìm thiết bị)

// ---------------------------------------------------------------- crypto.cpp: danh tính ECDSA P-256 (khớp GatewayIdentity.cs)
void cryptoBegin();
String idPublicKey();                            // SPKI DER base64url
String idHw();                                   // 20 ký tự Crockford của SHA-256(SPKI)
String idSign(const String& msg);                // chữ ký IEEE P1363 base64url
bool verifyCmd(const String& payload, const String& mqttId, const String& keyB64u, String& unsignedOut);
bool verifySig(const String& spkiB64u, const String& msg, const String& sigB64u);   // ECDSA P-256 P1363, khoá SPKI
std::vector<uint8_t> tlsCertDer();               // chứng chỉ TLS tự ký từ khoá danh tính (dấu nhận dạng = idHw)
struct mbedtls_pk_context;
mbedtls_pk_context* idKey();
String b64u(const uint8_t* p, size_t n);
std::vector<uint8_t> fromB64u(const String& s);
String sha256Hex(const uint8_t* p, size_t n);
String fingerprint();                            // XXXX-XXXX (để người duyệt đối chiếu)

// ---------------------------------------------------------------- io.cpp: DI/DO, LED, còi, nút BOOT
void ioBegin();
uint8_t ioDi();                                  // DI đã lọc rung (task nền lấy mẫu 2 ms; xem io.cpp)
uint32_t ioDiCount(int ch);                      // số lần chuyển 0→1 (cạnh lên) của DI ch (0..7) sau lọc, 32 bit vòng
void ioDiCountSet(int ch, uint32_t v);           // đặt lại bộ đếm
uint8_t ioDo();
bool ioSetDo(uint8_t mask);                      // ghi TCA9554 rồi ĐỌC LẠI để xác nhận; lỗi I2C → gỡ kẹt bus, thử lại một lần
bool ioDoOk();                                   // TCA9554 đang trả lời và thanh ghi khớp trạng thái mong muốn (false = DO không tin được)
// Bảo vệ tiếp điểm relay: thời gian tối thiểu giữa hai lần ĐỔI trạng thái của từng DO. Nguồn: cấu hình board (field Unit 0 có MinToggleMs)
// và PC đang giữ lease (DoMinMs gửi kèm nhịp tim); lấy giá trị LỚN hơn. Chặn mọi đường ghi DO: engine/cloud, API LAN, Modbus TCP slave.
void ioDoMinCfg(const uint32_t* ms8);           // từ cấu hình board (storeApply)
void ioDoMinLease(const uint32_t* ms8);         // từ PC giữ lease (chỉ hiệu lực khi lease còn)
uint32_t ioDoWaitMs(uint8_t mask);              // ms còn phải chờ trước khi được đặt DO = mask (0 = được ngay)
uint32_t ioDoLastChange(int ch);                // millis lần đổi trạng thái gần nhất của DO ch (0..7); 0 = chưa đổi lần nào
void ioLed(uint8_t r, uint8_t g, uint8_t b);
void ioBeep(int ms);
void ioLoop();                                   // nút BOOT

// ---------------------------------------------------------------- modbus.cpp
void modbusBegin();
void modbusReconfigure();                        // sau khi cấu hình đổi (baud/parity/host)
bool mbRead(const Field& f, int addr, int count, uint16_t* out, String& err);
bool mbWrite(const Field& f, int addr, const uint16_t* words, int count, String& err);

// ---------------------------------------------------------------- slave.cpp: CHẾ ĐỘ GATEWAY (lease) + Modbus TCP slave
// Mặc định board chạy ĐỘC LẬP: tự đọc thiết bị, đẩy MQTTS lên cloud. Khi một PC admin (GatewayApp/C# gateway) xin LEASE qua API mã hoá
// (POST /api/lease, gia hạn bằng nhịp tim) board chuyển sang chế độ GATEWAY: tạm dừng MQTTS, KHÔNG poll RS485 cho cloud, mở Modbus TCP slave
// cho đúng IP đó. Unit 0 = I/O board (FC01/02/03/04/05/06/16, xem modbus.cpp); Unit n ≠ 0 = cầu sang RS485 (board vẫn là master RS485).
// Mất nhịp tim quá hạn → tự về độc lập.
bool leaseActive();
IPAddress leaseHolder();
void leaseSet(const IPAddress& ip, uint32_t ttlMs);
void leaseRelease();
uint32_t leaseRemainingMs();
void slaveLoop();

// ---------------------------------------------------------------- engine.cpp: đọc theo chu kỳ, giá trị, ghi
extern bool g_running;
extern String g_status;                          // online | plc_fault | no_devices | đã dừng
void engineBegin();
void engineRestart();                            // cấu hình đổi: bỏ giá trị cũ, đọc lại ngay
String engineWrite(const String& child, const String& key, double v, bool byWire);   // "" = ok, còn lại mã lỗi (read_only, value_out_of_range…)
void engineValues(JsonObject out);               // "child.field" → số (cho GET /api/state)
String engineTelemetry();                        // {"schema":2,"d":{child:{khoá:số}}}; rỗng = chưa có giá trị
void engineAges(JsonObject out);                 // "child.field" → ms từ lần đọc được gần nhất (field chưa đọc được lần nào: không có)
int32_t engineAgeMs(const String& key);          // -1 = chưa từng đọc được (logic dùng: tuổi quá lớn → coi như mất cảm biến)
uint32_t engineSeq();                            // tăng mỗi chu kỳ đọc xong

// ---------------------------------------------------------------- alert.cpp: cảnh báo ngưỡng tính tại gateway (AlertEngine.cs)
void alertEvaluate(const String& telemetry, std::vector<String>& fired);
// ---------------------------------------------------------------- backfill.cpp: dữ liệu lúc mất cloud → gửi bù khi nối lại (LocalHistoryDb.cs)
void backfillRecord(const String& telemetry, bool cloudOk);   // gọi mỗi chu kỳ đọc; tự lấy mẫu theo LocalHistoryIntervalSec
bool backfillNext(String& payload);                           // gói bù kế tiếp {"schema":2,"bf":1,"ts":…,"d":…}; false = hết
void backfillAck();                                           // gói vừa lấy đã gửi xong → bỏ khỏi hàng đợi
size_t backfillPending();

// ---------------------------------------------------------------- api.cpp: API LAN cho GatewayApp + tìm thiết bị UDP
void apiBegin();
void apiLoop();
void apiOpenWindow(uint32_t ms);                 // mở ghép PC admin mới trong khoảng này (nút BOOT / lúc khởi động)
void apiForgetAdmins();                          // reset: xoá danh sách PC admin đã ghép

// ---------------------------------------------------------------- cloud.cpp
void cloudBegin();
void cloudLoop();
void cloudRestart();                             // cấu hình cloud đổi: nối lại
bool cloudLinkOk();                              // MQTT đang nối (đường mạng hiện tại ra được Internet)
String cloudStateName();                         // Disabled | Disconnected | Connecting | Connected (CloudState của C#)
// Việc cloud do admin yêu cầu (POST /api/cloud): register (value = LoginResult JSON) | enroll (value = QR). Trả (ok, câu báo).
bool cloudAction(const String& action, const String& api, const String& value, String& msg);
/// Ghép PC bằng webapp (OTP) thay cho nút BOOT: hỏi server (VPS hoặc server cài trên PC trong LAN) tài khoản của phiên webapp
/// có sở hữu board này không. false + why khi không (chưa đăng ký cloud, không có server, không phải chủ…).
bool cloudOwnsBoard(const String& webToken, String& why);
bool timeSynced();
int64_t nowMs();

// ---------------------------------------------------------------- safety.cpp: chế độ an toàn + tắt DO khi mất người điều khiển
// Chế độ AN TOÀN: khởi động lại bất thường (panic / watchdog / sụt áp) ≥ 3 lần liền, mỗi lần chạy chưa đủ 2 phút → DO giữ TẮT,
//   mọi lệnh BẬT bị từ chối ("safe_mode") cho tới khi chạy ổn định 30 phút (hoặc tắt nguồn bật lại — power_on xoá bộ đếm).
// Mất người điều khiển: xem Field::lossOffSec. "Người điều khiển" = MQTT cloud (chạy độc lập, cloud bật) hoặc PC giữ lease.
void safetyBegin();                              // sau wdtBegin (cần bootReason), trước ioBegin
bool safeMode();
uint32_t safetyBootFails();                      // số lần khởi động lại bất thường liên tiếp (gồm lần này)
void safetyLossCfg(const uint32_t* sec8);        // từ cấu hình (storeApply)
void safetyLink(bool cloudExpected, bool lease, bool cloudUp);   // loop(): cloud có bật không, PC đang giữ lease không, MQTT đang nối không
void safetyTick();                               // task io (500 ms): bộ đếm khởi động, hết chế độ an toàn, tắt DO khi mất kết nối

// ---------------------------------------------------------------- wdt.cpp: watchdog phần mềm theo từng task + watchdog phần cứng cho chính nó
// Mỗi task gọi wdtFeed() mỗi vòng; quá hạn → ghi tên task vào NVS ("wdt") rồi khởi động lại (DO về TẮT ở ioBegin).
// Task giám sát được Task WDT của ESP-IDF canh: chính nó treo (hoặc cả scheduler) thì chip tự reset.
enum WdId { WD_LOOP, WD_POLL, WD_DI, WD_IO, WD_COUNT };
void wdtBegin();                                 // gọi ĐẦU TIÊN trong setup(): ghi nhận lý do khởi động, chạy task giám sát
void wdtArm(int id, uint32_t timeoutMs);         // bắt đầu canh (hoặc đổi hạn) — gọi trong chính task đó
void wdtFeed(int id);
String bootReason();                             // lý do lần khởi động này: power_on | sw | panic | wdt:<task> | brownout …

// ---------------------------------------------------------------- rtc.cpp: đồng hồ PCF85063 trên board (I2C chung với TCA9554)
// Khởi động: RTC hợp lệ → đặt giờ hệ thống ngay (có giờ cả khi mất mạng). Có giờ mạng (NTP / header Date của server) → ghi lại vào RTC.
void rtcBegin();                                 // sau ioBegin (Wire đã chạy)
void rtcLoop();                                  // trong loop(): ghi giờ mạng xuống RTC khi cần
void rtcNoteNetTime();                           // giờ hệ thống vừa được đặt theo mạng
bool timeTrusted();                              // có giờ tin được (mạng hoặc RTC hợp lệ) — logic theo lịch dùng cờ này
const char* timeSource();                        // ntp | rtc | none

// ---------------------------------------------------------------- tiện ích
void logf(const char* fmt, ...);
