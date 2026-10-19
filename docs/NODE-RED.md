# Node-RED: cầu nối PLC khác (Siemens S7, Modbus TCP...) vào webapp

## Khi nào dùng
- PLC **không** nói Modbus RTU qua RS485 (ví dụ Siemens S7-1200/1500/300, hoặc PLC có cổng Ethernet/Modbus TCP).
- Node-RED chạy **tại nhà máy** (mini PC, Raspberry Pi, hoặc chính PC này khi thử) và thay vai trò gateway ESP32. Nó nói giao thức của PLC ở một phía và **đúng hợp đồng MQTT hiện tại** ở phía kia ([PROTOCOL.md](PROTOCOL.md)), nên **webapp không phải sửa**.
- Không đặt Node-RED trên cloud: nó phải ở cùng mạng với PLC, và như vậy máy chủ cloud vẫn chỉ chuyển tiếp gói tin. Node-RED dùng khoảng 50 MB RAM khi chạy.

```
PLC ──S7 / Modbus TCP──> Node-RED (nhà máy) ──wss──> broker ──wss──> webapp
```

## Chạy
1. Sinh luồng (chọn một):
   ```powershell
   # Modbus TCP (Delta, Inovance, Schneider, Xinje có Ethernet...)
   python tools/gen_flows.py --protocol modbus --plc-host 192.168.1.50 --mqtt-pass <mật khẩu gw>
   # Siemens S7
   python tools/gen_flows.py --protocol s7 --plc-host 192.168.0.1 --rack 0 --slot 1 --db 1 --mqtt-pass <mật khẩu gw>
   ```
   Mặc định broker là `wss://plc-mqtt.dieukhientudong.net:443/mqtt`, site `factory1`, thiết bị `plc01` (đổi bằng `--mqtt`, `--site`, `--dev`). Kết quả ghi vào `edge/data/flows.json` và `flows_cred.json` (mật khẩu, đã nằm trong `.gitignore`).
2. Khởi động:
   ```powershell
   cd edge; docker compose up -d --build
   ```
   Trình soạn thảo Node-RED ở http://127.0.0.1:21880 (chỉ truy cập từ máy này, không mở ra internet).
3. Không chạy đồng thời Node-RED và gateway ESP32 cho **cùng** thiết bị (trùng site/thiết bị).

## Bản đồ dữ liệu
Cùng 40 thanh ghi như [PROTOCOL.md](PROTOCOL.md). Với Siemens, tạo một **DB1** gồm mảng `INT` (không bật "Optimized block access"; bật "Permit PUT/GET" trong thuộc tính bảo vệ CPU) và đặt thanh ghi thứ *i* ở `DB1.DBW(2*i)`:

| Khối | Địa chỉ trong DB1 | Số phần tử |
|---|---|---|
| Thanh ghi chính D0–D39 | `INT0.40` | 40 |
| Lịch sử theo giờ D100–D150 | `INT200.51` | 51 |
| Thời gian chạy D199–D248 | `INT398.50` | 50 |
| Ghi D3, D4, D6, D7, D9 | `INT6`, `INT8`, `INT12`, `INT14`, `INT18` | 1 |

Chương trình S7 tự cập nhật các giá trị này (đếm, trạng thái băng tải...) và đọc lại D3/D4/D6/D7/D9 do webapp ghi vào. Muốn địa chỉ khác, sửa `gen_flows.py` (bảng `vt`).

## Truy vấn dữ liệu PLC từ webapp
**Cài đặt → Truy vấn dữ liệu PLC**: nhập địa chỉ và số lượng (0–299, tối đa 20), bấm Đọc. Lệnh `{"op":"read","a":100,"n":4}` đi qua MQTT; Node-RED (hoặc gateway ESP32) đọc rồi trả về `{"id":"..","ok":true,"a":100,"v":[...]}`.
- Modbus: đọc trực tiếp từ PLC, mọi vùng 0–299.
- S7: trả từ ba khối đang đọc (D0–D39, D100–D150, D199–D248); vùng khác trả lỗi.
- Ghi chỉ cho phép D3, D4, D6, D7, D9, cả ở Node-RED lẫn gateway.

## Đã kiểm thử và chưa kiểm thử
- **Đã thử** (PLC Modbus TCP giả lập `tools/modbus_tcp_sim.py`, broker thử, webapp): telemetry theo thay đổi + nhịp 10 s, lịch sử theo giờ, ghi lệnh (D7, D6 tới PLC), truy vấn đọc, từ chối ghi ngoài danh sách, báo `plc_fault` khi mất PLC và tự phục hồi, ack lỗi khi PLC không trả lời.
- **Chưa thử với PLC Siemens thật.** Luồng S7 đã nạp được vào Node-RED và endpoint S7 khởi tạo, nhưng chưa có CPU để đọc/ghi. Ack ghi S7 là *lạc quan* (báo ngay khi gửi); giá trị thật xác nhận qua telemetry kế tiếp.
- Địa chỉ biến S7 dùng cú pháp của `node-red-contrib-s7` (`DB1,INT0.40`): nếu CPU báo lỗi đọc mảng, thử chia thành khối nhỏ hơn.

## An toàn
- Node-RED giữ mật khẩu MQTT dạng văn bản trong `edge/data/flows_cred.json`: đừng đưa file này lên git hay thư mục chia sẻ.
- Không công khai cổng 21880. Nếu cần truy cập từ xa, đặt đăng nhập (`adminAuth` trong `settings.js`) trước.
- Khoá liên động an toàn (E-stop, chạy khô, dừng khi đủ số lượng) vẫn nằm trong PLC, không phụ thuộc mạng hay Node-RED.
