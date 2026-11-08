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
| Thiết bị | **＋ Thêm thiết bị ngoại vi**: chọn loại thiết bị (mẫu nhãn/đơn vị/chữ trạng thái), rồi **khai báo rõ**: giao thức, kết nối (địa chỉ, cổng, tuỳ chọn), thông số riêng của giao thức (Unit ID, CPU/rack/slot/DB, tag/slot, dòng PLC, node FINS, AMS NetId/port/symbol, namespace/node OPC UA), thứ tự word, và từng field: quyền (chỉ đọc / chỉ ghi / đọc-ghi), kiểu dữ liệu (UINT, INT, BOOL, UDINT, DINT, REAL, LREAL), thanh ghi D, hệ số, Min/Max ghi, kiểu hiển thị. Sửa; **Xoá có hộp xác nhận** (mặc định "Không") |
| Giao thức | Mỗi giao thức một **kết nối** (địa chỉ, cổng, tuỳ chọn mức kết nối, chu kỳ đọc), **Kiểm tra kết nối** bằng chính một field đã khai báo, **Lưu**. Nhiều giao thức chạy cùng lúc |
| Cloud | Bật/tắt đồng bộ (tắt = chạy hoàn toàn cục bộ), dán QR tem + **Enroll**, cấu hình nâng cao (toàn bộ `ScadaConfig`) |
| Nhật ký | `PLC→GW`, `GW→PLC`, `GW→Cloud`, `Cloud→GW` kèm nội dung JSON |

- **Không có giá trị ngầm định**: gateway chỉ đọc đúng các word của field đã khai báo (không đọc D0–D39 hay lịch sử), telemetry chỉ gồm `{"schema":2,"d":{…}}`; chưa có thiết bị thì không chạy; field "chỉ đọc" từ chối lệnh ghi (`read_only`), kiểu số nguyên ngoài khoảng bị từ chối (`bad_value`).
- Mỗi field = `d.<thiết bị>.<field> = giải mã(kiểu, thứ tự word, word từ D) / hệ số`. Field từ tem enroll chưa có giao thức/thanh ghi/hệ số: khai báo ở trang Thiết bị trước khi chạy.
- Cùng bộ thông số và khoá với PlcSim (`Plciot.Scada.ProtocolSpec`); xem `tools/PlcSim/README.md`.
- Điều khiển đi qua đúng đường của gateway (`ScadaCore.ExecuteKeyAsync`): whitelist theo Pack + giới hạn Min/Max.
- Cấu hình: `%ProgramData%\PlciotScada\gateway-app\config.json` và `config.ui.json` (cách hiển thị). Demo không ghi đè.
- Biến môi trường `GATEWAYAPP_SETTINGS` đổi đường dẫn file cấu hình (dùng cho thử nghiệm).
- Kiểm tra tự động: `--shot THƯ_MỤC` (chụp các trang), `--selftest THƯ_MỤC` (thêm thiết bị bằng hộp thoại thật, chạy Modbus TCP 1502 + OPC UA 4841 tới PlcSim nạp `e2e/plcsim-settings.json`, đọc/ghi/xoá, ghi `gateway-result.txt`).
