# GatewayAdmin — tool cài đặt gateway của khách từ xa

```powershell
dotnet run --project tools/GatewayAdmin
GatewayAdmin.exe --connect 127.0.0.1:8750 --token MÃ
```

1. Trên gateway của khách (`GatewayApp.exe --customer`): vào trang **Kết nối admin**, bật "Cho phép admin cài đặt" (bật thêm "máy khác trong LAN" nếu nối qua IP). Gateway hiện **mã 8 chữ số** và địa chỉ.
2. Mở tool, nhập `IP:cổng` + mã đó, bấm **Kết nối**.
3. Trang **Tổng quan** (xem/điều khiển qua gateway), **Thiết bị** (thêm/sửa/xoá), **Giao thức** (kết nối). Mỗi thay đổi tự gửi sang gateway; gateway lưu và khởi động lại luồng đọc.
4. Nút **Chạy/Dừng** điều khiển luồng đọc PLC của gateway.

Lưu ý: nút "Kiểm tra kết nối" ở trang Giao thức chạy từ máy admin, không phải từ gateway.
