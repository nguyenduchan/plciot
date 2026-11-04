# Playbook ứng phó sự cố an ninh / dữ liệu cá nhân

## 1. Mục tiêu

Phát hiện → khoanh vùng → khắc phục → thông báo (nội bộ, chủ thể, cơ quan khi pháp luật yêu cầu) → rút kinh nghiệm.

## 2. Đầu mối

| Vai trò | Liên hệ |
|---|---|
| On-call kỹ thuật | |
| Đầu mối BVDLCN (DPO) | `DPO_CONTACT` / `DPO_EMAIL` |
| Quản lý dịch vụ | |

## 3. Phân loại nhanh

| Mức | Ví dụ | Hành động trong 1 giờ |
|---|---|---|
| P1 | Lộ DB, chiếm admin, điều khiển trái phép hàng loạt | Khoá login/remote (`ops_flags`), xoay JWT/MQTT, giữ forensic |
| P2 | Lộ một tài khoản, brute-force kéo dài | Khoá user, revoke session, audit |
| P3 | Nghi ngờ / lỗi cấu hình chưa lộ | Điều tra, vá, theo dõi |

## 4. Checklist kỹ thuật plciot

1. Bật/tắt khẩn: Console ops flags — `login_open`, `remote_control_open`, `mqtt_ingest_open`.
2. Thu hồi phiên: tăng `token_version` / logout-all / xoá `app_sessions`.
3. Xoay bí mật: `APP_JWT_SECRET` (cân nhắc downtime), MQTT user pass, claim root nếu lộ tem.
4. Trích `audit_log` theo `user_id` / khoảng thời gian (trước khi purge retention).
5. Sao lưu snapshot DB trước khi sửa hàng loạt.

## 5. Thông báo

- **Nội bộ:** DPO + quản lý trong 1–4 giờ với P1.
- **Chủ thể bị ảnh hưởng:** khi có rủi ro cao đến quyền/lợi ích — mô tả loại dữ liệu, biện pháp, cách liên hệ (không gửi mật khẩu/recovery qua kênh không an toàn).
- **Cơ quan nhà nước:** theo Luật An ninh mạng / BVDLCN khi đủ điều kiện — DPO chủ trì nội dung pháp lý (không tự ý công bố kỹ thuật chi tiết lỗ hổng chưa vá).

## 6. Sau sự cố

- Viết báo cáo: timeline, nguyên nhân, dữ liệu ảnh hưởng, hành động, ngăn chặn tái diễn.
- Cập nhật DPIA / quy chế nếu cần.
- Rà soát lại quyền admin và backup.
