# Mẫu đánh giá tác động bảo vệ dữ liệu (DPIA) — dịch vụ IoT plciot

Điền trước khi thương mại hóa B2C rộng hoặc xử lý quy mô lớn. Tham chiếu Luật BVDLCN 2025 / NĐ 356/2025.

## A. Mô tả xử lý

| Mục | Nội dung |
|---|---|
| Tên xử lý | Vận hành tài khoản + giám sát/điều khiển PLC qua MQTT |
| Bên kiểm soát | |
| Hệ thống | plciot cloud app + gateway + broker |
| Chủ thể | Người vận hành nhà máy / kỹ thuật viên dùng app |
| Dữ liệu | Username, IP/audit, passkey pubkey, telemetry site/device |
| Dữ liệu nhạy cảm? | Không lưu sinh trắc thô; WebAuthn chỉ pubkey |
| Người nhận | Admin nội bộ; nhà cung cấp hạ tầng (liệt kê) |

## B. Cần thiết & tỷ lệ

- Mục đích kinh doanh / an toàn vận hành nhà máy.
- Có phương án thay thế ít xâm nhập hơn không? (đã bỏ SĐT/OTP).
- Thời hạn lưu: retention gói + `AUDIT_RETENTION_DAYS`.

## C. Rủi ro cho chủ thể

| Rủi ro | Khả năng | Hậu quả | Biện pháp hiện có |
|---|---|---|---|
| Chiếm tài khoản / điều khiển máy | Trung bình | Cao (an toàn sản xuất) | Passkey, TOTP, cooling 24h, step-up control |
| Lộ lịch sử vận hành | Trung bình | Trung bình | Wipe, retention, ACL MQTT |
| Lộ bí mật MQTT trên DB | Thấp–TB | Trung bình | AES seal `mqtt_pass`; mã hoá ổ |
| Admin lạm quyền | Thấp | Cao | Ít admin, audit, reauth |

## D. Kết luận

- [ ] Rủi ro chấp nhận được sau biện pháp  
- [ ] Cần biện pháp bổ sung (liệt kê)  
- [ ] Cần tham vấn chuyên gia / cơ quan (nếu áp dụng)

Ngày đánh giá: ________ · Người thực hiện: ________ · Phê duyệt: ________
