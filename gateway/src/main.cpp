// Modbus RTU master (PLC) <-> MQTT. Stateless pipe: polls a register block and publishes
// it raw; executes whitelisted single-register writes received on <base>/cmd.
// MQTT uses ESP-IDF esp-mqtt so it can speak mqtt:// or wss:// (TLS WebSocket) to the broker.
#include <Arduino.h>
#include <ETH.h>
#include <mqtt_client.h>
#include <esp_crt_bundle.h>
#include <freertos/queue.h>
#include <ArduinoJson.h>
#include "config.h"

static esp_mqtt_client_handle_t mc;
static volatile bool mqttUp = false, ethUp = false;
static QueueHandle_t cmdQ;                       // cmd payloads, handled in loop() (owns the RS485 port)
struct Cmd { char s[160]; };
static String base = String("plc/") + SITE + "/" + DEVICE;
static String tTele = base + "/telemetry", tStatus = base + "/status",
              tCmd = base + "/cmd", tAck = base + "/ack", tHist = base + "/history";
static uint16_t regs[REG_COUNT];
static uint16_t lastSent[REG_COUNT];
static uint32_t lastPub = 0;
static uint8_t plcFails = 0;

// Registers that tick every second (uptime D10-11, per-output runtime D20-35) must not trigger a
// publish on their own; they ride along with the next change or heartbeat.
static bool significantChange() {
  for (int i = 0; i < REG_COUNT; i++) {
    int d = REG_FIRST + i;
    if (d == 10 || d == 11 || (d >= 20 && d <= 35)) continue;
    if (regs[i] != lastSent[i]) return true;
  }
  return false;
}
static const char *lastStatus = "";

static uint16_t crc16(const uint8_t *b, size_t n) {
  uint16_t c = 0xFFFF;
  while (n--) { c ^= *b++; for (int i = 0; i < 8; i++) c = (c & 1) ? (c >> 1) ^ 0xA001 : c >> 1; }
  return c;
}

// Send a request, read exactly rxLen bytes (or an exception frame). True on valid reply.
static bool xfer(uint8_t *tx, size_t n, uint8_t *rx, size_t rxLen) {
  uint16_t c = crc16(tx, n - 2);
  tx[n - 2] = c & 0xFF; tx[n - 1] = c >> 8;
  while (Serial2.available()) Serial2.read();
  digitalWrite(PIN_RS485_DE, HIGH);
  Serial2.write(tx, n);
  Serial2.flush();
  digitalWrite(PIN_RS485_DE, LOW);
  size_t got = 0;
  uint32_t t0 = millis();
  while (millis() - t0 < 300 && got < rxLen) {
    if (Serial2.available()) {
      rx[got++] = Serial2.read();
      if (got >= 5 && (rx[1] & 0x80)) break;       // exception reply
    }
  }
  if (got < 5 || rx[0] != PLC_UNIT || (rx[1] & 0x80)) return false;
  return got == rxLen && crc16(rx, got - 2) == (uint16_t)(rx[got - 2] | rx[got - 1] << 8);
}

// Read n (<= 60) holding registers starting at D<first> into out[].
static bool readBlock(uint16_t first, uint8_t n, uint16_t *out) {
  uint8_t tx[8] = {PLC_UNIT, 3, (uint8_t)(first >> 8), (uint8_t)first, 0, n, 0, 0};
  uint8_t rx[5 + 2 * 60];
  if (n > 60 || !xfer(tx, 8, rx, 5 + 2 * n)) return false;
  for (int i = 0; i < n; i++) out[i] = rx[3 + 2 * i] << 8 | rx[4 + 2 * i];
  return true;
}
static bool readRegs() { return readBlock(REG_FIRST, REG_COUNT, regs); }

// Hourly history kept inside the PLC (so the cloud stores nothing):
//   D100 current-hour count, D101..D148 previous 48 hours (newest first), D149 seconds into this hour,
//   D150 hour roll-over counter, D199 conveyor-run seconds this hour, D200..D248 run minutes per hour.
// Published retained on <base>/history once a minute.
static uint32_t lastHist = 0;
static void publishHistory() {
  uint16_t a[51], b[50];                       // D100..D150, D199..D248
  if (!readBlock(100, 51, a) || !readBlock(199, 50, b)) return;
  String o = "{\"c\":[";
  for (int i = 0; i < 49; i++) { if (i) o += ','; o += a[i]; }
  o += "],\"s\":"; o += a[49]; o += ",\"n\":"; o += a[50];
  o += ",\"r\":"; o += b[0]; o += ",\"m\":[";
  for (int i = 1; i < 50; i++) { if (i > 1) o += ','; o += b[i]; }
  o += "]}";
  pub(tHist, o.c_str(), true);
  lastHist = millis();
}

static bool writeReg(uint16_t a, uint16_t v) {
  uint8_t tx[8] = {PLC_UNIT, 6, (uint8_t)(a >> 8), (uint8_t)a, (uint8_t)(v >> 8), (uint8_t)v, 0, 0};
  uint8_t rx[8];
  return xfer(tx, 8, rx, 8);
}

static void pub(const String &topic, const char *msg, bool retain, int qos = 0) {
  if (mqttUp) esp_mqtt_client_publish(mc, topic.c_str(), msg, 0, qos, retain);
}

static void setStatus(const char *s) {
  if (strcmp(s, lastStatus) == 0 || !mqttUp) return;
  pub(tStatus, s, true, 1);
  lastStatus = s;
}

static void handleCmd(const char *json) {
  JsonDocument d;
  if (deserializeJson(d, json)) return;
  if (String(d["op"] | "") == "read") {            // query any register range straight from the PLC (0..299)
    uint16_t a = d["a"] | 0xFFFF, n = d["n"] | 1, buf[60];
    JsonDocument r;
    r["id"] = d["id"];
    bool ok = a < 300 && n >= 1 && n <= 60 && a + n <= 300 && readBlock(a, (uint8_t)n, buf);
    if (ok) { r["a"] = a; JsonArray v = r["v"].to<JsonArray>(); for (uint16_t i = 0; i < n; i++) v.add(buf[i]); }
    r["ok"] = ok;
    String out; serializeJson(r, out);
    pub(tAck, out.c_str(), false);
    return;
  }
  uint16_t a = d["a"] | 0xFFFF, v = d["v"] | 0;
  bool ok = false;
  for (uint16_t w : WRITABLE) if (w == a) ok = true;
  if (ok) ok = writeReg(a, v);
  JsonDocument r;
  r["id"] = d["id"];
  r["ok"] = ok;
  String out; serializeJson(r, out);
  pub(tAck, out.c_str(), false);
  if (ok) plcFails = 0;
}

static void onMqtt(void *, esp_event_base_t, int32_t id, void *data) {
  auto e = (esp_mqtt_event_handle_t)data;
  if (id == MQTT_EVENT_CONNECTED) {
    mqttUp = true;
    lastStatus = "";
    esp_mqtt_client_subscribe(mc, tCmd.c_str(), 1);
  } else if (id == MQTT_EVENT_DISCONNECTED) {
    mqttUp = false;
  } else if (id == MQTT_EVENT_DATA && e->current_data_offset == 0 && e->data_len < sizeof(Cmd::s)) {
    Cmd c;
    memcpy(c.s, e->data, e->data_len);
    c.s[e->data_len] = 0;
    xQueueSend(cmdQ, &c, 0);
  }
}

static void mqttStart() {
  static String cid = String("gw-") + DEVICE;
  static String lwt = tStatus;
  esp_mqtt_client_config_t cfg = {};
  cfg.uri = MQTT_URI;
  cfg.client_id = cid.c_str();
  cfg.username = MQTT_USER;
  cfg.password = MQTT_PASS;
  cfg.keepalive = 30;                       // stays well under Cloudflare's 100 s idle timeout
  cfg.lwt_topic = lwt.c_str();
  cfg.lwt_msg = "offline";
  cfg.lwt_qos = 1;
  cfg.lwt_retain = 1;
  cfg.buffer_size = 1024;
  cfg.crt_bundle_attach = esp_crt_bundle_attach;   // verify the server certificate (Mozilla CA bundle)
  mc = esp_mqtt_client_init(&cfg);
  esp_mqtt_client_register_event(mc, MQTT_EVENT_ANY, onMqtt, nullptr);
  esp_mqtt_client_start(mc);                // auto-reconnects
}

void setup() {
  Serial.begin(115200);
  cmdQ = xQueueCreate(4, sizeof(Cmd));
  pinMode(PIN_RS485_DE, OUTPUT);
  digitalWrite(PIN_RS485_DE, LOW);
  Serial2.begin(RS485_BAUD, RS485_CONFIG, PIN_RS485_RX, PIN_RS485_TX);
  WiFi.onEvent([](arduino_event_id_t e) {
    if (e == ARDUINO_EVENT_ETH_GOT_IP) {
      ethUp = true;
      static bool started = false;
      if (!started) { started = true; mqttStart(); }
    }
    if (e == ARDUINO_EVENT_ETH_DISCONNECTED || e == ARDUINO_EVENT_ETH_STOP) ethUp = false;
  });
  ETH.begin(1, 16, 23, 18, ETH_PHY_LAN8720, ETH_CLOCK_GPIO0_IN);   // WT32-ETH01 pinout
}

void loop() {
  static uint32_t lastPoll = 0;
  Cmd c;
  while (xQueueReceive(cmdQ, &c, 0) == pdTRUE) handleCmd(c.s);

  if (millis() - lastPoll < POLL_MS) { delay(5); return; }
  lastPoll = millis();

  if (readRegs()) {
    plcFails = 0;
    if (lastHist == 0 || millis() - lastHist > HISTORY_MS) publishHistory();
    if (!significantChange() && millis() - lastPub < HEARTBEAT_MS) { setStatus("online"); return; }
    String out = "{\"r\":[";
    for (int i = 0; i < REG_COUNT; i++) { if (i) out += ','; out += regs[i]; }
    out += "]}";
    pub(tTele, out.c_str(), true);
    memcpy(lastSent, regs, sizeof regs);
    lastPub = millis();
    setStatus("online");
  } else if (++plcFails >= 3) {
    setStatus("plc_fault");
  }
}
