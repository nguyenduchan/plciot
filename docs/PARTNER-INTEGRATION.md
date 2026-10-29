# Partner Integration — Cloud monitor/control

Tài liệu hợp đồng để công ty solution / thiết bị IoT MQTTS gắn vào cloud **plciot** mà không cần hiểu nội bộ PLC.

| Tài liệu / mã | Nội dung |
|---|---|
| `cloud/app/src/contract.js` | Topic, schema, endpoints |
| `tenants.js` + `partnerRoutes.js` | Provision + REST + webhook |
| `docs/openapi-partner.yaml` | OpenAPI 3 Partner API |
| `tools/gw_sim.py` | Simulator MQTT (`--ns iot --tenant …`) |

## 0. Trạng thái đề xuất kiến trúc

| Đề xuất | Trạng thái |
|---|---|
| Hợp đồng MQTT versioned (`plc/` + `iot/{tenant}/`) | Đã có |
| Multi-tenant + provision API + ACL | Đã có |
| MQTTS công khai (HAProxy :8883 → listener control) | Đã có (infra) + endpoint trong provision |
| Control server-authoritative + solution profiles | Đã có |
| REST history / last telemetry / cmd (partner) | Đã có |
| Webhook status / alarm / count_done | Đã có |
| Edge bridge (Node-RED) cho PLC không MQTT | Đã có (`edge/`, docs/NODE-RED.md) |
| Simulator + OpenAPI kit | Đã có |
| mTLS client-cert / partner portal UI | Chưa (P3/P4) — dùng user/pass MQTTS + API key |
| Thanh toán online / tự mua gói | **Không làm** (quy định) — cấp tay trên VPS: [SUBSCRIPTION-OPS.md](SUBSCRIPTION-OPS.md) |

## 1. Kiến trúc ngắn

```
Thiết bị MQTTS / Edge bridge  ──mqtts──▶  Mosquitto (ACL theo tenant)
                                              │
Partner app (REST) / điện thoại ──HTTPS──▶  plciot-app
                                              │
                                    user `ctl` publish …/cmd
                                    webhooks ──POST──▶ partner URL
```

Ba đường tích hợp:

1. **Native MQTTS** — thiết bị nói đúng contract topic/JSON  
2. **Edge bridge** — Node-RED/gateway map Modbus/S7 → contract  
3. **REST only** — partner không mở MQTT: đọc history + gửi cmd qua HTTPS  

## 2. Topic

| Kiểu | Mẫu |
|---|---|
| Legacy (gateway hiện có) | `plc/{site}/{device}/{kind}` |
| Chuẩn đa tenant | `iot/{tenant}/{site}/{device}/{kind}` |

`kind` ∈ `telemetry` | `status` | `history` | `cmd` | `ack`

`MQTT_DUAL_NS=true` (mặc định): ACL + ingest cả hai. Thiết bị partner mới → `iot/…`.

Contract sống: `GET /api/v1/contract`.

## 3. Payload (schema v1)

```json
{"schema":1,"ts":1730000000,"r":[/* D0.. */]}
{"schema":1,"id":"a1b2c","a":6,"v":1}
{"schema":1,"id":"a1b2c","ok":true}
```

Status / LWT (retain): `online` | `offline` | `plc_fault`.

## 4. Onboard

### 4.1 Admin tạo tenant

```http
POST /api/admin/tenants
Authorization: Bearer <admin-jwt>
{"id":"acme","name":"ACME Solutions","profile":"conveyor-v1"}
```

`apiKey` trả **một lần**.

### 4.2 Partner cấp thiết bị

```http
POST /api/v1/devices
Authorization: Bearer <apiKey>
{"site":"plant1","device":"gw01","profile":"conveyor-v1"}
```

Nhận `mqtt.username/password`, `mqtt.mqtts`, `device.topicBase`.

### 4.3 REST monitor / control

```http
GET  /api/v1/devices/plant1/gw01/telemetry/last
GET  /api/v1/devices/plant1/gw01/history?since=&until=
POST /api/v1/devices/plant1/gw01/cmd
{"a":6,"v":1}
```

Lệnh partner đi qua cùng whitelist profile; **không** yêu cầu Passkey điện thoại (API key = M2M). Tắt bằng `PARTNER_CMD_ENABLED=false`.

### 4.4 Webhook

```http
POST /api/v1/webhooks
{"url":"https://partner.example/hooks/plciot","events":["status","alarm","count_done"]}
```

- Body JSON: `{ event, ts, tenant, site, device, data }`  
- Header `X-Plciot-Signature: sha256=<hmac>` (HMAC-SHA256 toàn body, secret lúc tạo)  
- Chỉ chấp nhận `https://` trừ khi `WEBHOOK_ALLOW_HTTP=true` (dev)

### 4.5 Xoay / thu hồi

```http
POST /api/v1/devices/plant1/gw01/rotate
DELETE /api/v1/devices/plant1/gw01
```

## 5. MQTTS

| Env | Ý nghĩa |
|---|---|
| `MQTT_PUBLIC_HOST` / `MQTT_DOMAIN` | Hostname broker |
| `MQTT_PUBLIC_MQTTS` | `mqtts://host:port` |
| `MQTT_PUBLIC_WSS` | `wss://…` |
| `PUB_PORT_MQTTS` | Cổng sau HAProxy (`docs/MAY-CHU-VIET-NAM.md`) |

TLS tại HAProxy `:8883` → Mosquitto `1884` (control). Thiết bị Internet dùng MQTTS/WSS.

## 6. Solution profiles

| Profile | Ghi được |
|---|---|
| `conveyor-v1` | D3, D4, D6, D7, D9 |
| `monitor-only` | không ghi |
| `generic-holding-v1` | D0–D39 |

Áp dụng cho `/api/control/cmd` và `/api/v1/.../cmd`.

## 7. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MQTT_PREFERRED_NS` | `plc` | Topic base app user |
| `MQTT_DUAL_NS` | `true` | ACL + ingest dual |
| `PARTNER_CMD_ENABLED` | `true` | Cho phép REST cmd |
| `RATE_LIMIT_PARTNER` | `60` | req/phút / tenant |
| `WEBHOOK_ALLOW_HTTP` | off | Dev only |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Timeout POST webhook |

## 8. Checklist thiết bị

- [ ] TLS / CA tới broker công khai  
- [ ] Credential từ provision  
- [ ] LWT `status=offline` retain  
- [ ] Publish `telemetry` retain; đọc `cmd`; `ack` khớp `id`  
- [ ] Không publish `cmd`  
- [ ] Reconnect + backoff  

## 9. Mô phỏng

```bash
# Legacy
python tools/gw_sim.py --port 21883 --user gw --password ... --site factory1 --dev plc01

# Partner iot/
python tools/gw_sim.py --port 21883 --user d_acme_plant1_gw01 --password ... \
  --ns iot --tenant acme --site plant1 --dev gw01
```

Smoke: `cloud/app/scripts/smoke-contract.js`, `smoke-partner-api.js`.
