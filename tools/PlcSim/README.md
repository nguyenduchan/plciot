# PlcSim — PLC giả lập (Windows)

Ứng dụng WinForms giả lập PLC để thử gateway C# (`scada/`) và webapp mà không cần phần cứng.

```powershell
dotnet run --project tools/PlcSim
```

## Giao thức

| Giao thức | Vai trò simulator | Cấu hình gateway C# (`ScadaConfig`) |
|---|---|---|
| Modbus TCP | slave, cổng 502 | `Source=ModbusTcp`, `PlcHost=<IP máy này>` |
| Mitsubishi MC 3E | server, cổng 5001 (Q/L và iQ-R) | `Source=MitsubishiMc`, `McPlcType` |
| Omron FINS UDP / TCP | server, cổng 9600 (DM) | `Source=OmronFins`, `FinsProtocol` |
| Siemens S7 | server ISO-on-TCP, cổng 102, DBW(2n) = D n | `Source=S7`, `S7Cpu`, `S7Db` |
| EtherNet/IP | server CIP, cổng 44818, tag INT[300] | `Source=EtherNetIp`, `EipTag` |
| OPC UA | server, cổng 4840 (`PLC_D`, `PLC_W<a>` ghi được) | `Source=OpcUa` |
| Beckhoff ADS | AMS router + PLC, cổng 48898 (gateway cùng máy, không cài TwinCAT) | `Source=BeckhoffAds` |
| MQTT → gateway | client, cổng 1883 | `Source=Gateway`, `LocalBrokerEnabled`, `LocalUsers` có `Role=Device` |

Ba giao thức đầu: gateway **poll** D0..D39 và **ghi** lệnh (D3/D4/D6/D7/D9) vào simulator — simulator log và cập nhật lưới ngay.
MQTT: simulator **đẩy** `plc/<site>/<device>/telemetry` = `{"schema":2,"r":[..],"d":{child:{field:v}}}`, `status`, nghe `cmd`, trả `ack`.
Gateway chuyển tiếp lên cloud → webapp. Lệnh từ webapp đi ngược lại đúng đường đó.

Tab **Lệnh nhận từ gateway / webapp**: mỗi lệnh ghi từ gateway/Modbus master hiện một dòng — giờ (ms), nguồn, thanh ghi D, thiết bị con tương ứng (`dev1.a`…) và giá trị. Dùng để đối chiếu thời điểm bấm trên webapp với lúc PLC nhận lệnh.

**Độ trễ** (đo trên VPS thật): giám sát PLC→webapp ≈ 0,2 s và điều khiển webapp→PLC ≈ 0,2 s khi gateway đặt `PollMs=200`, `CloudTelemetryFastMs=150` (mặc định `PollMs=1000` cho ≈ 0,5 s). Giữ `CloudTelemetryMinMs≥1000` để không vượt giới hạn ingest ~120 tin/phút.

## Dữ liệu nhập

Mặc định **rỗng**. Chỉ có giao thức qua Ethernet (chưa có RS232/RS485 và digital).

- **＋ Thêm luồng dữ liệu**: **giao thức** (Modbus, MC, FINS, S7, EtherNet/IP, OPC UA, ADS, MQTT), **quyền** (chỉ đọc / chỉ ghi / đọc và ghi), **thông số riêng của giao thức** (cùng khoá với gateway: Unit ID, dòng PLC, node FINS, CPU/rack/slot/DB, tag/slot, AMS NetId/port/symbol, namespace/node OPC UA; hiện luôn địa chỉ gateway sẽ dùng), thiết bị (child), field, thanh ghi D, hệ số (D = giá trị × hệ số) và cách sinh giá trị: cố định, ngẫu nhiên trong khoảng Min–Max, sóng sin (chu kỳ), tăng dần (bước/giây). Trùng D bị từ chối. Chỉ đọc: gateway ghi vào bị từ chối (ghi vào nhật ký); chỉ ghi: không sinh giả lập, giữ giá trị gateway ghi. Sửa / **Xoá (có xác nhận, mặc định "Không")** hoặc phím Delete.
- **⚙ Kết nối…**: chọn một giao thức rồi sửa thông số kết nối của nó (mỗi giao thức một bộ; bấm Bắt đầu sẽ mở một máy chủ cho mỗi giao thức đang có luồng): địa chỉ/cổng, Site, Device, MQTT user/password, chu kỳ gửi, tên tag (EtherNet/IP, ADS).
- Tab **Thanh ghi D**: sửa D0..D39, hoặc ghi D bất kỳ (0–299). Ô **Chạy mô phỏng giá trị** bật/tắt mọi bộ sinh giá trị.

Thiết bị con với giao thức thanh ghi: gateway có bảng `Pack` cùng quy ước (D = field × hệ số) để đóng gói `d.<child>.<field>`; MQTT gửi thẳng `d.<child>.<field>`.
Cấu hình lưu ở `%APPDATA%\PlcSim\settings.json` (không lưu mật khẩu); biến môi trường `PLCSIM_SETTINGS` đổi đường dẫn. `--selftest THƯ_MỤC` thêm luồng bằng hộp thoại thật, chạy Modbus TCP cổng 1502 và ghi `plcsim-result.txt`.
