# Chia nhóm Mosquitto: số tiến trình theo cấu hình, tạo tự động

Mosquitto đơn luồng. Để dùng nhiều core: chạy N tiến trình, mỗi tiến trình giữ một tập gateway cố định. **N chỉ là một biến cấu hình** (file `cloud/.env`):

```bash
MQTT_SHARDS=1        # 1..16 tiến trình, hoặc auto = số core - MQTT_RESERVE_CORES
MQTT_RESERVE_CORES=1 # chỉ dùng khi auto: core dành cho app ingest/haproxy/hệ điều hành
MQTT_MEM_LIMIT=128m  # RAM container mqtt: ~64 MB cho mỗi nhóm
```

Sau khi đổi: `.\cloud\scripts\sync-vps.ps1 -Build` (hoặc `docker compose up -d --build`). Không phải sửa compose/haproxy bằng tay.

## Cái gì tự tạo theo MQTT_SHARDS
- **Broker** (`config/mqtt-entrypoint.sh`): trong container `plciot-mqtt` chạy N tiến trình Mosquitto, mỗi tiến trình ghim một core bằng `taskset`, tự khởi động lại nếu chết, nhận SIGHUP để tải lại ACL. Cấu hình mỗi nhóm sinh từ `config/mosquitto.conf`: cổng = cổng gốc + 10×k, `passwd`/`acl`/dữ liệu riêng (nhóm 0 giữ đường dẫn cũ, nhóm k ở `config/shard<k>/`), `memory_limit` chia đều theo RAM container. N=1 chạy thẳng như trước.
- **HAProxy** (`config/haproxy-entrypoint.sh`): mỗi nhóm k ≥ 1 có cổng mqtts công khai **cổng gốc + k** (tối đa 16 nhóm, dải cổng `PUB_PORT_MQTTS`…`PUB_PORT_MQTTS_END`, mặc định 48263–48278; mở dải này ở tường lửa) và wss ở đường dẫn `/mqtt-k`. Nhóm ≥ 1 chỉ có kênh mã hoá.
- **Server** (`cloud/app/src/shards.js`): nhóm của gateway = 8 hex đầu của `mqttId` mod N; sinh ACL/passwd từng nhóm; ingest nối mọi nhóm; lệnh điều khiển tới đúng nhóm; kit enroll cấp cổng của nhóm. `GET /api/me` trả `mqtt.shards = { count, of: {<mqttId>: nhóm}, endpoints }` để webapp mở một kết nối MQTT mỗi nhóm có gateway của người dùng.

## Số nhóm: bằng số CPU hay CPU − 1?
- Cùng máy với app ingest + haproxy + DB + hệ điều hành: **CPU − 1** (`MQTT_SHARDS=auto`, mặc định dành 1 core).
- Máy chỉ chạy broker: **bằng số CPU** (`MQTT_SHARDS=auto` + `MQTT_RESERVE_CORES=0`).
- VPS 2 core: 1 nhóm — chia nhóm chưa có lợi ở máy này.

## Lưu ý khi đổi N
- Đổi N làm đổi nhóm của nhiều gateway đã cấp: gateway phải được cấp lại cấu hình (cổng mqtts mới nằm trong kit/QR). Chỉ nên tăng N khi chưa có nhiều gateway thật, hoặc cấp lại tem hàng loạt.
- Webapp cần mở nhiều kết nối theo `mqtt.shards` (chưa làm: hiện webapp dùng một kết nối `cfg.url`).
- Kiểm tra cấu hình tự động (container tạm, không đụng dịch vụ thật): `bash cloud/scripts/test-mqtt-shards.sh` (broker), `bash cloud/scripts/test-haproxy-shards.sh` (haproxy hợp lệ với mọi N, **chạy trước khi triển khai**) và `node scripts/smoke-shards.js` (server).
