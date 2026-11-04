# Quy chế bảo vệ dữ liệu cá nhân (nội bộ)

Mẫu vận hành cho đội plciot / đơn vị triển khai. **Điền tên pháp nhân, ngày ban hành, chữ ký trước khi đưa vào hồ sơ chính thức.**

## 1. Phạm vi

Áp dụng cho hệ thống IoT cloud/app plciot xử lý dữ liệu gắn tài khoản người dùng, nhật ký bảo mật, telemetry theo site/device trên lãnh thổ Việt Nam hoặc phục vụ công dân/tổ chức Việt Nam.

## 2. Vai trò

| Vai trò | Trách nhiệm |
|---|---|
| Người kiểm soát dữ liệu | Pháp nhân vận hành dịch vụ (điền tên) |
| Đầu mối BVDLCN (DPO) | Tiếp nhận yêu cầu chủ thể, phối hợp sự cố — cấu hình `DPO_*` |
| Kỹ thuật / vận hành | Triển khai biện pháp kỹ thuật, sao lưu, phân quyền admin |
| Hỗ trợ khách hàng | Chỉ truy cập dữ liệu khi có yêu cầu hợp lệ và ghi audit |

## 3. Nguyên tắc

1. Mục đích rõ, tối thiểu hóa, giới hạn thời gian lưu.
2. Không thu thập SĐT/email cho OTP nếu sản phẩm không cần.
3. Mọi truy cập admin nhạy cảm cần step-up / reauth khi hệ thống hỗ trợ.
4. Sự cố an ninh có thể ảnh hưởng DLCN → kích hoạt [INCIDENT-RESPONSE.md](./INCIDENT-RESPONSE.md).

## 4. Quyền chủ thể

- Xem / xuất: hướng dẫn dùng Cài đặt → Xuất dữ liệu, hoặc hỗ trợ thủ công trong SLA.
- Xóa: self-service xoá tài khoản; hoặc yêu cầu qua DPO (xác minh danh tính thiết bị/username + yếu tố khôi phục).
- Rút đồng ý: tương đương xoá tài khoản hoặc ngừng sử dụng dịch vụ sau khi đã xoá dữ liệu theo quy trình.

## 5. Nhà cung cấp / xử lý hộ

Liệt kê cloud, DNS, tunnel, email (nếu có). Mỗi bên: hợp đồng / DPA, phạm vi dữ liệu, nơi xử lý. *(Mục chuyển biên giới: đánh giá riêng — không thuộc phạm vi triển khai kỹ thuật lần này.)*

## 6. Đào tạo & rà soát

- Đào tạo onboarding kỹ thuật/hỗ trợ về không lộ MQTT pass, recovery codes, audit.
- Rà soát quy chế + DPIA tối thiểu hàng năm hoặc khi đổi kiến trúc lớn.

## 7. Ban hành

- Ngày: ________  
- Người phê duyệt: ________  
- Đầu mối BVDLCN: ________  
