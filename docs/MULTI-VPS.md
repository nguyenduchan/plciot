# Thiết kế: nhiều VPS theo gói (Vietnix giá rẻ / Viettel-FPT giá cao)

Trạng thái: **thiết kế, chưa cài đặt**. Mục tiêu: gói Miễn phí/Cơ bản chạy trên VPS rẻ (Vietnix), gói Nâng cao/Nhà máy chạy trên VPS đắt hơn, đĩa lớn hơn (Viettel/FPT), mà người dùng **không phải đổi địa chỉ web**.

## Nguyên tắc
- **Mặt phẳng điều khiển (một nơi duy nhất)**: tài khoản, gói, chat, admin, web/app, sao lưu chính. Địa chỉ web `plc.dieukhientudong.net` và `adminplc…` không đổi.
- **Mặt phẳng dữ liệu (nhiều "node")**: broker MQTT + ghi lịch sử telemetry. Mỗi node là một VPS. Một thiết bị thuộc đúng **một node** (`devices.node_id`), chọn theo gói của chủ thiết bị.
- Địa chỉ MQTT khác nhau theo node nhưng **do server cấp** trong kit enroll/QR (người dùng không gõ). Tên miền MQTT là bản ghi DNS **chỉ-DNS (không qua proxy Cloudflare)**, ví dụ `mqtt-lite.…` và `mqtt-pro.…`, mỗi tên có chứng chỉ CA thật (Let's Encrypt) để không phải ghim chứng chỉ.

## Hiện trạng liên quan (đã có trong mã)
- Mosquitto chia nhóm (`MQTT_SHARDS`, `shards.js`): nhóm của gateway = 8 hex đầu `mqttId` mod N; mỗi nhóm một cổng công khai (cổng gốc + k).
- Địa chỉ cấp cho gateway lấy từ biến môi trường **toàn cục** `MQTT_PUBLIC_HOST` (`contract.js: mqttPublicEndpoints`, `gatewayEnroll.js`).
- App ingest nối broker nội bộ, ghi `mqtt_events` vào `app.db` cùng máy và chạy luôn phần phụ (policy, cảnh báo, webhook, push) dựa vào các bảng trong cùng DB.
- Webapp mở **một** kết nối MQTT (`cfg.url`); `GET /api/me → mqtt.shards` đã mô tả nhiều endpoint nhưng webapp chưa dùng (ghi trong `SHARDING.md`).

Chỗ khó nhất: ingest đang gắn chặt với DB chính (cảnh báo, webhook, push, policy). Nên chia theo giai đoạn.

## Phân bổ gói → node

| Gói | Node | VPS |
|---|---|---|
| Miễn phí, Cơ bản | `lite` | Vietnix (rẻ, đĩa nhỏ — lịch sử ≤ 7 ngày, ~15 MiB/widget) |
| Nâng cao, Nhà máy | `pro` | Viettel/FPT (đĩa lớn hơn, lịch sử 30 ngày đến 10 năm) |
| Mặt phẳng điều khiển | `pro` | cùng máy với node `pro` (giữ VPS hiện tại), vì đây là máy cần ổn định nhất và có sao lưu |

Hai VPS là đủ lúc đầu. Nếu `pro` đầy đĩa thì thêm node `pro-2` (cùng cơ chế).

## Bảng và cấu hình mới
- `nodes(id, name, tier, mqtt_host, mqtts_port, wss_url, ingest_url, api_url, capacity_widgets, status)`.
- `devices.node_id` (hoặc theo `users`; gateway kế thừa node của chủ) — mặc định node hiện tại để không phá dữ liệu cũ.
- `PLAN_CATALOG[plan].node = 'lite' | 'pro'`.
- `mqttPublicEndpoints(shard, node)` lấy host/cổng/wss từ node thay vì biến toàn cục.
- Giá: `pricing.js` đọc **chi phí VPS và đĩa của node mà gói đó chạy** (`PRICING_VPS_VND_MONTH` và `PRICING_DISK_USABLE_GB` theo node) thay vì một giá chung. Gói Nhà máy (một lần 10 năm) tính theo VPS `pro`, gói Cơ bản theo VPS `lite`. Cần bạn cung cấp giá và đĩa thật của hai VPS.

## Ba giai đoạn

### Giai đoạn 1 — broker ở nhiều node, ghi lịch sử vẫn ở DB chính
- Node `lite` chỉ chạy Mosquitto + HAProxy (stack nhỏ). Server chính sinh `passwd`/`acl` cho từng node và **đẩy sang node** (HTTPS có ký HMAC hoặc rsync qua SSH) rồi gửi SIGHUP.
- Ingest của app chính nối **qua TLS** tới mọi broker node.
- Lợi: tách mạng/CPU broker, mỗi gói có endpoint riêng, chuẩn bị cho giai đoạn 2. **Không tiết kiệm đĩa** (lịch sử vẫn dồn về DB chính), nên giai đoạn này chưa đạt mục tiêu chi phí.
- Việc: bảng `nodes`, endpoint theo node, đẩy ACL, ingest nhiều URL (mở rộng `shardUrls`), webapp mở nhiều kết nối theo `mqtt.shards`.

### Giai đoạn 2 — lịch sử nằm trên node (đạt mục tiêu chi phí)
- Node chạy **chế độ node** của cùng image app: broker + ingest + `app.db` lịch sử cục bộ (chỉ `mqtt_events`, chặn cửa sổ lịch sử theo gói).
- Phần phụ của ingest (cảnh báo, webhook, push, policy) gửi về máy chính bằng sự kiện nhỏ `POST /internal/node/event` (HMAC, có hàng đợi/thử lại), không ghi trực tiếp vào DB chính.
- Truy vấn lịch sử: app chính **proxy** `GET /api/history` tới `api_url` của node (token dịch vụ ngắn hạn). Web/app vẫn chỉ gọi một địa chỉ.
- Xoá/gộp dữ liệu cũ, sao lưu và kéo sao lưu ngoài VPS chạy **trên từng node** (đã có: `thinOldTelemetryAsync`, `dbBackup`, `pull-backup.ps1` — cần chạy cho từng node).
- Việc: chế độ node của app, endpoint nội bộ, proxy lịch sử, cấu hình sao lưu từng node, giám sát từng node.

### Giai đoạn 3 — đổi gói giữa hai node
Khi nâng/hạ gói làm đổi node (Cơ bản ↔ Nâng cao):
1. Admin duyệt đổi gói (như hiện tại); hệ thống đánh dấu `devices.node_id` đích ở trạng thái `migrating`.
2. Xuất `mqtt_events` của thiết bị (site/device) từ node cũ, nhập vào node mới (theo lô, có kiểm số dòng).
3. Cập nhật ACL/passwd hai node, cấp lại kit (host mới) cho gateway; gateway kết nối broker mới.
4. Khi gateway đã online ở node mới thì xoá dữ liệu cũ ở node cũ.
- Khoảng 5–15 phút gateway có thể mất dữ liệu (giữa lúc ngắt và kết nối lại); báo rõ trong chat.
- **Cần kiểm tra trước khi hứa với khách:** gateway hiện nhận cấu hình broker mới qua kênh nào (kit/QR lúc enroll, hay cập nhật từ xa). Nếu chỉ qua QR thì mỗi lần đổi node phải cấu hình lại gateway tại chỗ. Cách giảm: gói Nâng cao/Nhà máy ngay từ đầu dùng node `pro`, đổi gói trong cùng node thì không phải chuyển gì (hạ Nâng cao → Cơ bản vẫn ở `pro` đến khi khách muốn chuyển).

## Có phải đổi URL cho mỗi VPS không
- **Địa chỉ web/app: không đổi** (một tên miền, qua Cloudflare).
- **Địa chỉ MQTT của gateway: có, theo node**, nhưng do server cấp lúc enroll; người dùng không nhập tay.
- **Webapp (xem số liệu trực tiếp)** cần kết nối thêm tới `wss` của node nếu thiết bị ở node khác máy chính (giai đoạn 1).
- Hai tên miền MQTT là bản ghi DNS không qua proxy Cloudflare (cổng 48263… phải mở ở tường lửa mỗi VPS).

## Rủi ro và cách giảm
| Rủi ro | Giảm |
|---|---|
| Máy chính hỏng làm cả hai gói mất quản lý | Sao lưu ngoài VPS cho từng node + máy chính; broker node vẫn nhận tin khi máy chính tạm mất (QoS 1, phiên persistent) |
| Node `lite` hỏng | Chỉ ảnh hưởng gói Miễn phí/Cơ bản; khôi phục từ sao lưu |
| Hai nơi cấu hình ACL lệch nhau | Server chính là nguồn duy nhất; node chỉ nhận bản đã ký; có lệnh kiểm tra lệch |
| Nhiều VPS tăng việc vận hành | Cùng một image/compose, một script `sync-vps.ps1 -Node <tên>`; CLAUDE.md ghi từng node |
| Tuân thủ | Không đổi: vẫn chỉ tài khoản + gói, không đơn hàng, không thanh toán qua hệ thống |

## Khuyến nghị
1. Bắt đầu **giai đoạn 2 trực tiếp cho thiết bị mới** thay vì làm giai đoạn 1 riêng, vì chỉ giai đoạn 2 mới tiết kiệm đĩa. Giai đoạn 1 là bước đệm nhỏ chứ không phải đích.
2. Chốt trước: giá + đĩa thật của VPS Vietnix và Viettel/FPT, và cách gateway nhận cấu hình broker mới.
3. Chỉ làm khi số khách thực sự cần: với vài khách hiện nay, một VPS 260k vẫn đủ; chia node làm tăng chi phí cố định (hai VPS) trước khi giảm được chi phí biến đổi.
