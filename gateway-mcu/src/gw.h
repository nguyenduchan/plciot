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
bool ioSetDo(uint8_t mask);
void ioLed(uint8_t r, uint8_t g, uint8_t b);
void ioBeep(int ms);
void ioLoop();                                   // nút BOOT

// ---------------------------------------------------------------- modbus.cpp
void modbusBegin();
void modbusReconfigure();                        // sau khi cấu hình đổi (baud/parity/host)
bool mbRead(const Field& f, int addr, int count, uint16_t* out, String& err);
bool mbWrite(const Field& f, int addr, const uint16_t* words, int count, String& err);

// ---------------------------------------------------------------- engine.cpp: đọc theo chu kỳ, giá trị, ghi
extern bool g_running;
extern String g_status;                          // online | plc_fault | no_devices | đã dừng
void engineBegin();
void engineRestart();                            // cấu hình đổi: bỏ giá trị cũ, đọc lại ngay
String engineWrite(const String& child, const String& key, double v, bool byWire);   // "" = ok, còn lại mã lỗi (read_only, value_out_of_range…)
void engineValues(JsonObject out);               // "child.field" → số (cho GET /api/state)
String engineTelemetry();                        // {"schema":2,"d":{child:{khoá:số}}}; rỗng = chưa có giá trị
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
String cloudStateName();                         // Disabled | Disconnected | Connecting | Connected (CloudState của C#)
// Việc cloud do admin yêu cầu (POST /api/cloud): register (value = LoginResult JSON) | enroll (value = QR). Trả (ok, câu báo).
bool cloudAction(const String& action, const String& api, const String& value, String& msg);
/// Ghép PC bằng webapp (OTP) thay cho nút BOOT: hỏi server (VPS hoặc server cài trên PC trong LAN) tài khoản của phiên webapp
/// có sở hữu board này không. false + why khi không (chưa đăng ký cloud, không có server, không phải chủ…).
bool cloudOwnsBoard(const String& webToken, String& why);
bool timeSynced();
int64_t nowMs();

// ---------------------------------------------------------------- tiện ích
void logf(const char* fmt, ...);
