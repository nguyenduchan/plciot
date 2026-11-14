# Chuyển VPS (Vietnix → Viettel/FPT khi có khách Nhà máy) và sao lưu

Một VPS duy nhất (xem `MULTI-VPS.md`: quyết định chưa chia node). Khi cần đĩa lớn hơn thì **chuyển cả hệ thống** sang VPS mới.

## 1. Chuẩn bị NGAY (trước khi có nhiều gateway)
Gateway nhớ địa chỉ MQTT lúc enroll. Hiện `MQTT_PUBLIC_HOST` là IP thô → đổi VPS = cấu hình lại mọi gateway. Đổi sang tên miền:
1. Cloudflare → DNS: bản ghi `A` **DNS only (mây xám)**, ví dụ `mqtts.dieukhientudong.net → <IP VPS>`. Bản ghi qua proxy không chạy được MQTTS cổng 48263.
2. Kiểm tra (không đổi gì): `.\cloud\scripts\set-mqtt-host.ps1 -NewHost mqtts.dieukhientudong.net`
   (DNS đúng IP, cổng mở, hash chứng chỉ khớp `MQTT_PUBLIC_PIN_SHA256`).
3. Áp dụng: thêm `-Apply`. Kit/QR cấp **từ lúc này** dùng tên miền; gateway đã enroll bằng IP cần cấu hình lại một lần.

## 2. Sao lưu ngoài VPS
- Trên VPS: tự động mỗi ngày (7 bản ngày + 4 bản tuần), tự bỏ qua nếu thiếu chỗ trống (≈ 1,2 × DB).
- Về máy cá nhân: `.\cloud\scripts\pull-backup.ps1` — kiểm tra bản sao trên VPS (`verify-backup.js`: `integrity_check`, đếm dòng) **trước khi kéo**, so kích thước sau khi kéo, ghi `%USERPROFILE%\plciot-backups\pull-backup.log`.
- Đặt lịch hàng tuần: `.\cloud\scripts\schedule-pull-backup.ps1` (gỡ: `-Remove`).
- **Thử khôi phục**: `docker exec plciot-app node scripts/verify-backup.js /app/data/backups/app-auto-YYYYMMDD.db` (hoặc trên máy khác với file kéo về). Làm ít nhất mỗi quý và trước mỗi lần chuyển VPS.
- DB hàng chục GB: bản kéo về nặng; khi đó nên dùng `rsync` (chỉ chép phần đổi) hoặc kho lưu trữ đối tượng thay cho `scp`.

## 3. Quy trình chuyển VPS
1. VPS mới: đĩa đủ (xem bảng 15/62/313 MiB/widget), cài `docker`, `git`, `rsync`; khoá SSH của máy mới được thêm vào máy cũ.
2. Trên **VPS mới**: `bash cloud/scripts/migrate-vps.sh root@<ip-cũ> --dry-run`, rồi chạy thật (bỏ `--dry-run`). Script chụp DB nhất quán (`db-snapshot.js`), chép mã/.env/config, dữ liệu app, và các docker volume **chứng chỉ MQTTS tự ký** (giữ nguyên hash ghim), phiên MQTT, caddy; rồi `docker compose up -d --build` và `verify-backup.js` trên DB mới.
3. Thử trước khi cắt: đăng nhập web/admin, xem lịch sử, cho một gateway thử nối tới máy mới.
4. Hạ TTL DNS xuống 60 giây trước đó; cắt DNS tên miền MQTT (DNS only) và đường hầm web sang máy mới. Gateway tự nối lại; broker giữ hàng đợi QoS 1.
5. Giữ máy cũ ≥ 7 ngày rồi mới xoá.
6. Cập nhật giá: `PRICING_VPS_VND_MONTH`, `PRICING_DISK_USABLE_GB` (giá gói Nhà máy tính theo VPS thật).

Chưa chạy thử đầu-cuối trên VPS thật thứ hai; `db-snapshot.js` và `verify-backup.js` đã chạy trên VPS hiện tại.

## 4. Theo dõi sức chứa
Trang admin có khung **Sức chứa VPS**: đĩa thật, DB, đĩa dự kiến theo gói, tổng widget, tốc độ tăng và số ngày còn lại. Ngưỡng: `CAP_WARN_PCT`(70) `CAP_CRIT_PCT`(85) `CAP_WIDGETS_WARN`(800) `CAP_WIDGETS_MAX`(1000); đĩa dùng được = `PRICING_DISK_USABLE_GB`. Mỗi giờ app ghi log `[capacity]` khi đổi mức. Cảnh báo chỉ hiển thị trên admin, không gửi ra ngoài.
