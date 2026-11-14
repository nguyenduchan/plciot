# Chia nhóm Mosquitto (mỗi nhóm một tiến trình, một core)

Mosquitto đơn luồng. Để dùng nhiều core: chạy N tiến trình, mỗi tiến trình giữ một tập gateway cố định.

- **Nhóm của gateway** = 8 hex đầu của `mqttId` mod `MQTT_SHARDS` (`cloud/app/src/shards.js`). Gateway tự nối đúng nhóm vì kit enroll/QR trả cổng công khai `48263 + nhóm`.
- **Người xem** (webapp) nối **một kết nối MQTT mỗi nhóm** chứa gateway của họ: `GET /api/me` → `mqtt.shards = { count, of: {<mqttId>: nhóm}, endpoints: {<nhóm>: {...}} }`. ACL nhóm nào chỉ chứa các `mqttId` thuộc nhóm đó.
- **Server**: ingest nối mọi nhóm (một kết nối/nhóm, xử lý chung một luồng + ghi lô); lệnh điều khiển gửi tới đúng nhóm.
- Mỗi nhóm có `config/shard<k>/{mosquitto.conf,acl,acl-monitor,passwd}`; nhóm 0 giữ `config/` và container `plciot-mqtt`.
- `passwd` được ghi vào mọi nhóm; quyền thật nằm ở ACL từng nhóm (user/gateway không có khối ACL ở nhóm nào thì không làm được gì ở đó).

## Số nhóm: bằng số CPU hay CPU − 1?
- Cùng máy với app ingest + haproxy + DB + hệ điều hành: **CPU − 1** (core còn lại cho app ingest, đang là điểm nghẽn).
- Máy chỉ chạy broker: **bằng số CPU**, mỗi tiến trình ghim một core (`cpuset`).
- VPS 2 core: 1 nhóm — chia nhóm chưa có lợi ở máy này.

## Bật chia nhóm
```bash
cd cloud/app
node scripts/gen-shards.js --cores 4 --reserve 1 --out ../shards-out   # chỉ ghi file mẫu, không đụng cấu hình chạy
```
1. Gộp `shards-out/haproxy.shards.cfg` vào `config/haproxy.cfg`, mở thêm cổng `48263+k` ở service haproxy, thêm `Caddyfile.shards`.
2. Chép `shards-out/shard<k>/` vào `cloud/config/`, chạy compose có thêm `docker-compose.shards.yml`.
3. Đặt `MQTT_SHARDS=N` cho service app, khởi động lại: ACL/passwd từng nhóm được dựng lại.
4. **Gateway đã cấp**: đổi N làm thay đổi nhóm của nhiều gateway → cấp lại cấu hình (QR/kit) trước khi đổi, hoặc chỉ tăng N khi chưa có gateway thật.
5. Webapp cần mở nhiều kết nối theo `mqtt.shards` (chưa làm: hiện webapp dùng một kết nối `cfg.url`).

Kiểm tra: `node scripts/smoke-shards.js`.
