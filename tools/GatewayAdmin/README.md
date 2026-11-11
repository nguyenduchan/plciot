# GatewayAdmin — tool cài đặt gateway của khách từ xa

```powershell
dotnet run --project tools/GatewayAdmin
GatewayAdmin.exe --connect 127.0.0.1:8750 --token MÃ
```

1. Trên gateway của khách (`GatewayApp.exe --customer`): vào trang **Kết nối admin**, bật "Cho phép admin cài đặt" (bật thêm "máy khác trong LAN" nếu nối qua IP). Gateway hiện **mã 8 chữ số tự đổi mỗi 60 giây** (có đếm lùi) và địa chỉ.
2. Mở tool, nhập `IP:cổng` + mã đang hiện, bấm **Kết nối**. Tool đổi mã lấy một mã phiên (`POST /api/login`), nên mã đổi sau đó không làm rớt phiên đang nối. Sai mã 5 lần bị khoá 1 phút. Mã cố định `--token` chỉ để kiểm thử.
3. Trang **Tổng quan** (xem/điều khiển), **Thiết bị** (thêm/sửa/xoá, chạy/tạm dừng từng thiết bị), **Giao thức** (kết nối), **Cloud** (đồng bộ, ghép cặp bằng mã admin, enroll QR, cấu hình nâng cao). Mỗi thay đổi tự gửi sang gateway; gateway lưu và khởi động lại luồng đọc (riêng chạy/tạm dừng thiết bị có hiệu lực ngay).
4. Gateway tự chạy khi mở (kể cả chưa có thiết bị); không còn nút Chạy/Dừng tổng. **Mọi thiết lập (thiết bị, giao thức, cloud) chỉ làm qua tool này**, gateway không có trang sửa.

Lưu ý: nút "Kiểm tra kết nối" ở trang Giao thức chạy từ máy admin, không phải từ gateway.
