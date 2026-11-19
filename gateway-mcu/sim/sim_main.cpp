// Điểm vào của bản giả lập trên PC: gọi đúng setup()/loop() của firmware (src/main.cpp). Chỉ biên dịch khi có -DGW_SIM.
#ifdef GW_SIM
#include <Arduino.h>
#include <direct.h>

void setup();
void loop();

// --cryptotest <khoá server SPKI b64u> <mqttId> <file lệnh đã ký>: kiểm crypto.cpp THẬT với chữ ký của server (cmdSign.js),
// và in khoá công khai + chữ ký "register|1|123" để kiểm ngược bằng Node. Dùng thư mục dữ liệu riêng (SIM_DATA) để không đụng khoá thật.
String idPublicKey(); String idSign(const String&); String idHw(); void cryptoBegin(); void storeBegin();
bool verifyCmd(const String&, const String&, const String&, String&);
static int cryptoTest(int argc, char** argv) {
  storeBegin(); cryptoBegin();
  printf("PUB %s\nHW %s\nSIG %s\n", idPublicKey().c_str(), idHw().c_str(), idSign("register|1|123").c_str());
  if (argc >= 5) {
    FILE* f = fopen(argv[4], "rb"); std::string p; char b[1024]; size_t n;
    while (f && (n = fread(b, 1, sizeof b, f)) > 0) p.append(b, n);
    if (f) fclose(f);
    while (!p.empty() && (p.back() == '\n' || p.back() == '\r')) p.pop_back();
    String plain; bool ok = verifyCmd(String(p), String(argv[3]), String(argv[2]), plain);
    printf("VERIFY %s %s\n", ok ? "ok" : "FAIL", plain.c_str());
    String tampered = String(p); tampered.replace("\"v\":1", "\"v\":9");
    printf("TAMPER %s\n", verifyCmd(tampered, String(argv[3]), String(argv[2]), plain) ? "ACCEPTED(lỗi!)" : "rejected");
    printf("OTHERID %s\n", verifyCmd(String(p), String("ffffffffffffffff"), String(argv[2]), plain) ? "ACCEPTED(lỗi!)" : "rejected");
  }
  return 0;
}

int main(int argc, char** argv) {
  WSADATA w; WSAStartup(MAKEWORD(2, 2), &w);
  if (argc >= 2 && strcmp(argv[1], "--cryptotest") == 0) { _mkdir(simDataDir()); return cryptoTest(argc, argv); }
  srand((unsigned)GetTickCount() ^ (unsigned)GetCurrentProcessId());
  _mkdir(simDataDir());
  printf("=== GATEWAY WAVESHARE — BẢN GIẢ LẬP TRÊN PC (không phải board) ===\n");
  printf("Dữ liệu: %s\\  ·  DI: sửa %s\\di.txt (vd. 0x05)  ·  RS485: SIM_COM=COMx  ·  Cổng API: SIM_API_PORT (đang %d)\n\n", simDataDir(), simDataDir(), simApiPort());
  setup();
  for (;;) loop();
}
#endif  // GW_SIM
