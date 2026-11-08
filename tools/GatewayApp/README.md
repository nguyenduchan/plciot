# GatewayApp — gateway C# có giao diện (chạy offline)

```powershell
dotnet run --project tools/GatewayApp            # mở giao diện, mặc định KHÔNG có thiết bị
dotnet run --project tools/GatewayApp -- --demo  # PLC giả trong chương trình (bồn nước + bơm), không cần PlcSim/mạng
dotnet run --project tools/GatewayApp -- --autostart   # tự chạy với cấu hình đã lưu
```

C# thuần (WinForms, vẽ bằng GDI+), không web, không CDN, không cần Internet. Cloud là tuỳ chọn.

| Trang | Việc |
|---|---|
| Tổng quan | Thẻ theo thiết bị (bồn nước, đồng hồ, công tắc, thanh trượt đặt giá trị, số) + biểu đồ lịch sử 5 phút / 1 giờ / 6 giờ |
| Thiết bị | **＋ Thêm thiết bị ngoại vi**: chọn loại thiết bị vật lý (11 mẫu, có sẵn nhãn/đơn vị/chữ trạng thái tiếng Việt) rồi chỉnh từng field (thanh ghi D, hệ số, Min/Max ghi, kiểu hiển thị, chữ Bật/Tắt, ngưỡng). Sửa; **Xoá có hộp xác nhận** (mặc định "Không") |
| Giao thức | Chọn 1 trong 9 giao thức (Modbus TCP/RTU, S7, EtherNet/IP, MC, FINS, ADS, OPC UA, ESP32 MQTT), nhập thông số, **Kiểm tra kết nối**, **Áp dụng & chạy lại** |
| Cloud | Bật/tắt đồng bộ (tắt = chạy hoàn toàn cục bộ), dán QR tem + **Enroll**, cấu hình nâng cao (toàn bộ `ScadaConfig`) |
| Nhật ký | `PLC→GW`, `GW→PLC`, `GW→Cloud`, `Cloud→GW` kèm nội dung JSON |

- Một nguồn PLC (một giao thức) mỗi lần; thiết bị ngoại vi nằm trên nguồn đó (mỗi field = một ô nhớ D, `d.<thiết bị>.<field> = D / hệ số`).
- Điều khiển đi qua đúng đường của gateway (`ScadaCore.ExecuteKeyAsync`): whitelist theo Pack + giới hạn Min/Max.
- Cấu hình: `%ProgramData%\PlciotScada\gateway-app\config.json` và `config.ui.json` (cách hiển thị). Demo không ghi đè.
- Biến môi trường `GATEWAYAPP_SETTINGS` đổi đường dẫn file cấu hình (dùng cho thử nghiệm).
- Kiểm tra tự động: `--shot THƯ_MỤC` (chụp các trang), `--selftest THƯ_MỤC` (thêm thiết bị bằng hộp thoại thật, chạy Modbus TCP cổng 1502 tới PlcSim, đọc/ghi/xoá, ghi `gateway-result.txt`).
