# GatewayApp — gateway C# có giao diện (chạy offline)

```powershell
dotnet run --project tools/GatewayApp            # mở giao diện, mặc định KHÔNG có thiết bị
dotnet run --project tools/GatewayApp -- --autostart   # tự chạy với cấu hình đã lưu
```

C# thuần (WinForms, vẽ bằng GDI+), không web, không CDN, không cần Internet. Cloud là tuỳ chọn.

| Trang | Việc |
|---|---|
| Tổng quan | Thẻ theo thiết bị (bồn nước, đồng hồ, công tắc, thanh trượt đặt giá trị, số) + biểu đồ lịch sử 5 phút / 1 giờ / 6 giờ |
| Thiết bị | **＋ Thêm thiết bị ngoại vi**: chọn loại thiết bị (mẫu nhãn/đơn vị/chữ trạng thái), rồi **khai báo rõ**: giao thức, kết nối (địa chỉ, cổng, tuỳ chọn), thông số riêng của giao thức (Unit ID, CPU/rack/slot/DB, tag/slot, dòng PLC, node FINS, AMS NetId/port/symbol, namespace/node OPC UA), thứ tự word, và từng field: quyền (chỉ đọc / chỉ ghi / đọc-ghi), kiểu dữ liệu (UINT, INT, BOOL, UDINT, DINT, REAL, LREAL), thanh ghi D, hệ số, Min/Max ghi, kiểu hiển thị. Sửa; **Xoá có hộp xác nhận** (mặc định "Không") |
| Giao thức | Mỗi giao thức một **kết nối** (địa chỉ, cổng, tuỳ chọn mức kết nối, chu kỳ đọc), **Kiểm tra kết nối** bằng chính một field đã khai báo, **Lưu**. Nhiều giao thức chạy cùng lúc |
| Thanh trên / Cloud | **Biểu tượng QR nhỏ** ở góc phải thanh trên (gateway và tool Admin) hiện khi đã đăng ký và còn nguyên sau khi tắt/mở app; bấm vào để phóng to, sao chép link, lưu PNG. Cloud: bật/tắt đồng bộ (tắt = chạy hoàn toàn cục bộ), chỉ nhập **mã ghép cặp** (địa chỉ server cố định `https://plc.dieukhientudong.net`, đổi bằng `CloudApiUrl`), cấu hình nâng cao (toàn bộ `ScadaConfig`) |
| Nhật ký | `PLC→GW`, `GW→PLC`, `GW→Cloud`, `Cloud→GW` kèm nội dung JSON |

- **Không có giá trị ngầm định**: gateway chỉ đọc đúng các word của field đã khai báo (không đọc D0–D39 hay lịch sử), telemetry chỉ gồm `{"schema":2,"d":{…}}`; chưa có thiết bị thì không chạy; field "chỉ đọc" từ chối lệnh ghi (`read_only`), kiểu số nguyên ngoài khoảng bị từ chối (`bad_value`).
- Mỗi field = `d.<thiết bị>.<field> = giải mã(kiểu, thứ tự word, word từ D) / hệ số`. Field từ tem enroll chưa có giao thức/thanh ghi/hệ số: khai báo ở trang Thiết bị trước khi chạy.
- Cùng bộ thông số và khoá với PlcSim (`Plciot.Scada.ProtocolSpec`); xem `tools/PlcSim/README.md`.
- Điều khiển đi qua đúng đường của gateway (`ScadaCore.ExecuteKeyAsync`): whitelist theo Pack + giới hạn Min/Max.
- Cấu hình: `%ProgramData%\PlciotScada\gateway-app\config.json` và `config.ui.json` (cách hiển thị).
- Biến môi trường `GATEWAYAPP_SETTINGS` đổi đường dẫn file cấu hình (dùng cho thử nghiệm).
- Kiểm tra tự động: `--solshot THƯ_MỤC` (chụp giao diện giải pháp, dữ liệu từ PlcSim), `--selftest THƯ_MỤC` (thêm thiết bị bằng hộp thoại thật, chạy Modbus TCP 1502 + OPC UA 4841 tới PlcSim nạp `e2e/plcsim-settings.json`, đọc/ghi/xoá, ghi `gateway-result.txt`).

## Chế độ khách + API cho tool admin

```powershell
GatewayApp.exe --customer                       # Tổng quan + Nhật ký + "Kết nối admin"; không có trang thiết lập
GatewayApp.exe --customer --api --token 12345678  # bật sẵn cho admin với mã cố định (kiểm thử)
```

- Token mặc định tạo ở `%ProgramData%\PlciotScada\gateway-app\api-token.txt` (cạnh file cấu hình); mọi yêu cầu cần `Authorization: Bearer <token>`.
- API (JSON, `Remote/Contract.cs`): `GET /api/state` · `GET /api/config` · `PUT /api/config` (đẩy thiết bị/giao thức/hiển thị; gateway kiểm tra, lưu, khởi động lại luồng đọc) · `POST /api/write` · `POST /api/run`.
- Mật khẩu (cloud, user local, cert) không gửi về tool; để trống khi đẩy = giữ nguyên.
- HTTP thường: chỉ dùng trong LAN tin cậy hoặc VPN.
- Tìm thiết bị: admin broadcast UDP `PLCIOT-DISCOVER` lên cổng 8751, gateway đang mở cho LAN trả `ApiHello` (`Kind` = `pc` | `mcu`).

## Thiết lập gateway khác qua LAN (Waveshare ESP32-S3 / gateway PC khác)

Nút **🔌 Kết nối Waveshare (LAN)** cuối thanh bên → chọn thiết bị tìm được hoặc nhập IP + mã kết nối → mở cửa sổ riêng
(`RemoteForm`) với **đúng các trang** Tổng quan / Thiết bị / Cloud / Nhật ký; mọi thay đổi đẩy xuống thiết bị qua API trên,
gateway trên PC này vẫn chạy. Đăng ký cloud: người cài đặt đăng nhập webapp trên máy admin, thiết bị chỉ nhận phiên
(`POST /api/cloud {Action:"register", Value:<LoginResult JSON>}`). Lối tắt: `GatewayApp.exe --remote IP[:cổng] --code MÃ`.

Kiểm thử (cần một gateway đích, vd. GatewayApp thứ hai `--customer --noauth --api --bind 0.0.0.0 --api-port 8760 --token 12345678`
với `GATEWAYAPP_SETTINGS` riêng, và `python tools/modbus_tcp_sim.py --port 5020`):
`GatewayApp.exe --lantest THƯ_MỤC --lan-target 127.0.0.1:8760 --lan-code 12345678 --lan-mb 5020` → `lantest-result.txt` (FAIL = lỗi) + ảnh chụp.
- Tool admin: `tools/GatewayAdmin` (dùng lại các trang giao diện của GatewayApp).
