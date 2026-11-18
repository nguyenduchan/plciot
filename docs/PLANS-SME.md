# Bộ gói dịch vụ DK10 … DK300 (7 nấc)

Mã gói theo kiểu "VT30" của Viettel: **DK + số thiết bị tối đa**. Nói với khách, ghi trên báo giá/hóa đơn, gõ khi cấp gói đều dùng **mã** (không phân biệt hoa thường: `dk30`, `DK-30` đều nhận).

**Mọi số liệu gói nằm trong file cấu hình, không có trong mã nguồn:** `cloud/app/config/plans.json` (bản mặc định đi kèm mã) và `cloud/app/data/plans.json` (bản chạy thật trên VPS, ưu tiên hơn, **không bị ghi đè khi sync**). Sửa file → server tự nạp lại trong ~30 giây, không build, không khởi động lại. File sai (JSON hỏng, trùng mã, số âm…) bị bỏ qua và giữ cấu hình đang chạy, kèm cảnh báo trong log.

## Bảng gói (giá trị mặc định trong plans.json)

Mã gói = số thiết bị tối đa, tăng theo từng nấc nhỏ: DK10 → DK20 → DK30 → DK50 → DK100 → DK200 → DK300. Giá chỉ là đề xuất.

| | **DK10** | **DK20** | **DK30** | **DK50** | **DK100** | **DK200** | **DK300** |
|---|---|---|---|---|---|---|---|
| id nội bộ (DB) | `free` | `plus` | `monitor` | `sme` | `pro` | `bizplus` | `factory` |
| Tên | Miễn phí — Pilot | Cá nhân Plus | Khởi đầu (Starter) | SME Tiêu chuẩn (Standard) | Doanh nghiệp (Business) | Doanh nghiệp Plus (Business Plus) | Nhà máy / Đối tác (Enterprise) |
| Giá đề xuất | 0 | 99.000đ/tháng | 199.000đ/tháng | 349.000đ/tháng | 799.000đ/tháng | 1.500.000đ/tháng | Trả một lần 10 năm (báo giá theo widget) |
| Gateway | 1 | 1 | 2 | 3 | 5 | 10 | 20 |
| Thiết bị | 10 | 20 | 30 | 50 | 100 | 200 | 300 |
| Nhân viên (ngoài chủ) | 2 | 3 | 4 | 6 | 20 | 40 | 50 |
| Gửi trực tiếp (có người xem) | 2 giây | 2 giây | 2 giây | 2 giây | 1 giây | 1 giây | 1 giây |
| Lưu vào DB | 1 phút | 1 phút | 30 giây | 30 giây | 30 giây | 30 giây | 10 giây |
| Thời hạn lưu | 30 ngày | 90 ngày | 120 ngày | 180 ngày | 365 ngày | 730 ngày | 10 năm |
| Lệnh điều khiển/phút | 60 | 60 | 90 | 120 | 300 | 450 | 600 |
| Xuất báo cáo | 7 ngày gần nhất | không giới hạn | không giới hạn | không giới hạn | không giới hạn | không giới hạn | không giới hạn |
| Quy tắc nâng cao | khoá | **mở** | **mở** | **mở** | **mở** | **mở** | **mở** |
| Webhook / REST API | khoá | khoá | khoá | khoá | **mở** | **mở** | **mở** |
| Logo riêng (white-label) | khoá | khoá | khoá | khoá | khoá | **mở** | **mở** |

Trả cả năm: giảm 2 tháng (10 tháng) cho các gói theo tháng. Mã hiển thị ở mọi nơi khách nhìn thấy (Cài đặt → Gói dịch vụ, chat nâng cấp, tên gói đang dùng).

Gói quá hạn tự quay về DK10. Gán gói: `node scripts/plan.js grant <username> DK30 [YYYY-MM-DD|never]` hoặc ở Console quản trị.

## Đã áp dụng thật trong hệ thống

| Giới hạn | Nơi áp dụng |
|---|---|
| Gửi trực tiếp (`telemetryMinMs`) | gateway tự gửi chậm theo gói (kit enroll) + ingest bỏ phần vượt |
| Chu kỳ lưu + gộp TB/min/max (`storeEveryMs`) | `cloud/app/src/aggregate.js` + `mqttIngest.js`: mỗi cửa sổ một dòng `{d: trung bình, agg:{n, mn, mx}}` |
| Thời hạn lưu (`retention`) | `retention.js` (xoá theo gói), cũng là mốc cho gói bù dữ liệu offline |
| Số thiết bị | `uiContract.applyWidgetLimit`: thiết bị vượt hạn mức bị khoá toàn bộ widget |
| Số gateway | `gatewayPairing.userGatewayLimit` (đăng ký + nhận chuyển gateway) |
| Số nhân viên | `sites.createInvite` (tính cả lời mời đang chờ) → lỗi `member_limit` |
| Lệnh/phút | `entitlements.takeRpcBudget` trong `/api/control/cmd` → 429 `rpc_limit` + `Retry-After` |
| Xuất báo cáo N ngày | `/api/history/export` (cột `value` = trung bình; thêm `min`, `max`, `samples`) |
| Webhook/API | `mayPartnerCmd`: tenant ở gói không có `integrations` không gửi lệnh đối tác |

## Cờ chưa có tính năng đứng sau (chỉ là cờ trong file, sẵn để gắn)

- `advancedRules` (quy tắc theo ca, nhiều cảm biến, email cuối ngày) và `whiteLabel` (logo riêng): hệ thống hiện chỉ có cảnh báo ngưỡng đơn giản trên gateway và chưa có chức năng logo riêng → cờ mới được **khai báo và trả về cho app** (`subscriptionInfo().limits`), chưa chặn/mở gì.
- `chatAlertsPerMonth` (Zalo/Telegram): **chưa có kênh**. Dự án đã bỏ Telegram/SĐT/email có chủ đích (danh tính theo thiết bị, xem `docs/CHAT-COMPLIANCE.md`); thêm kênh này là quyết định riêng về quyền riêng tư, nên mới chỉ là con số dự kiến.

## Đổi gói thế nào

1. Sửa `cloud/app/data/plans.json` trên VPS (hoặc sửa `cloud/app/config/plans.json` trong repo rồi build lại để đổi bản mặc định). Chưa có file thật thì chép từ bản mặc định.
2. Đợi ~30 giây (hoặc `PLANS_RELOAD_MS`). Không cần khởi động lại.
3. **Đừng đổi/xoá `id` của gói đang có người dùng** (lưu ở `users.sub_plan`); đổi `code`, tên, giá, hạn mức tùy ý. Thêm gói mới = thêm một khối trong `plans`; thứ tự khai báo là thứ hạng gói.
4. Người dùng đã được gán gói giữ nguyên `retention_days` đã ghi lúc cấp; muốn áp thời hạn mới cho họ thì cấp lại gói.

Ghi chú ước lượng đĩa (252 byte/dòng): DK10 ≈ 43.000 dòng/gateway/30 ngày ≈ 11 MB; DK30 ≈ 518.000 dòng/180 ngày ≈ 130 MB/gateway; DK100 ≈ 1,05 triệu dòng/365 ngày ≈ 265 MB/gateway (tối đa 5 gateway ≈ 1,3 GB/tài khoản).
