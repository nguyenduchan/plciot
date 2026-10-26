# Phần mềm local nhà máy: Node-RED + InfluxDB + Grafana

```
 PLC ──Modbus TCP / S7 / OPC UA / EtherNet/IP / MC / FINS / ADS──► Node-RED ──wss/mqtts──► MQTT server ──► webapp điện thoại
                                                                      │ ├─ trang /scada  (giám sát + điều khiển, nhiều màn hình, có đăng nhập + vai trò)
                                                                      │ ├─ Modbus TCP server / OPC UA server (chỉ đọc, cho HMI/MES khác)
                                                                      │ └─ ghi InfluxDB ──► Grafana (dashboard giám sát)
```
Thay cho SCADA C# (`scada/`) khi nhà máy chọn Node-RED + Grafana: cùng hợp đồng MQTT ([PROTOCOL.md](PROTOCOL.md)) nên webapp điện thoại và cloud không đổi.

## Chạy
```powershell
cd edge
copy .env.example .env                       # điền mật khẩu, INFLUX_TOKEN (openssl rand -hex 32), SCADA_USERS ...
python ..\tools\gen_flows.py --protocol modbus --plc-host 192.168.1.10 --mqtt-pass <mật khẩu gw> --serve modbus,opcua
python ..\tools\gen_grafana.py               # chỉ khi muốn sinh lại dashboard
docker compose up -d --build
```
| Thành phần | Địa chỉ | Ghi chú |
|---|---|---|
| Trang điều khiển | `http://<ip-máy>:8080/scada` | nginx → Node-RED, đăng nhập `SCADA_USERS` |
| Grafana | `http://<ip-máy>:3000` | tài khoản `admin` + `GRAFANA_ADMIN_PASSWORD`; tạo thêm user Viewer cho các màn hình |
| Editor Node-RED | `http://127.0.0.1:21880` | chỉ máy này |
| InfluxDB | `127.0.0.1:8086` | chỉ máy này |
| Modbus TCP server | `<ip-máy>:1502` | chỉ đọc |
| OPC UA server | `opc.tcp://<ip-máy>:4840` | chỉ đọc |

## Giao thức PLC (client) — `--protocol`
| Giá trị | Thư viện | Cách đọc | Trạng thái kiểm chứng |
|---|---|---|---|
| `modbus` | node-red-contrib-modbus | FC03/FC06 | **Chạy thật** với `tools/modbus_tcp_sim.py` |
| `s7` | node-red-contrib-s7 | DB1 `INT[]` | luồng nạp được, chưa có CPU Siemens |
| `opcua` | node-red-contrib-opcua | mảng `UInt16[300]` (`--opcua-image`), ghi từng nút (`--opcua-write`) | **chưa nạp được** trên máy dev (Node 18); Docker dùng Node 22 |
| `eip` | node-red-contrib-cip-ethernet-ip | tag `INT[300]` (`--eip-tag`), đọc từng phần tử | nạp được, chưa có PLC Rockwell |
| `mc` | node-red-contrib-mcprotocol | `DUINT0,300` | nạp được, chưa có PLC Mitsubishi |
| `fins` | node-red-contrib-omron-fins | `D0` × 300 | nạp được, chưa có PLC Omron |
| `ads` | node-red-contrib-ads-client | symbol mảng `INT[300]` (`--ads-symbol`) | nạp được, chưa có TwinCAT |

Các giao thức ngoài Modbus/S7 đọc cả "ảnh" 300 thanh ghi D0–D299 mỗi 1 s (cùng bản đồ như PROTOCOL.md) và chỉ ghi D3, D4, D6, D7, D9. Ghi của S7/EtherNet/IP/MC/FINS/ADS/OPC UA báo ack **lạc quan**; giá trị thật xác nhận ở telemetry kế tiếp. Địa chỉ/biến trong PLC cần khớp tuỳ chọn tương ứng.

## Lắng nghe làm server (`--serve`)
- **Modbus TCP server**: trả holding/input register 0–299 từ ảnh mới nhất; mọi lệnh ghi bị từ chối (`illegal function`); khi PLC mất liên lạc trả exception 4 thay vì dữ liệu cũ. Điều khiển chỉ qua MQTT hoặc `/scada`.
- **OPC UA server**: các biến `PLC/Status, Online, Inputs, Outputs, Alarms, Mode, RunRequest, Target, Conveyor, Count, Total, RunSeconds, PumpStarts`. Mặc định cho phép ẩn danh và là monitor-only (ghi từ client OPC UA không tới PLC): **chỉ mở trong LAN tin cậy**. Chưa kiểm chứng.
- S7, EtherNet/IP, MC, FINS, ADS chỉ hỗ trợ ở vai trò client; chúng là giao thức riêng của hãng, không có server dùng chung.

## Điều khiển: ba cửa vào, cùng một whitelist
1. **Điện thoại/cloud (MQTT)** → cổng điều khiển từ xa: `SCADA_ALLOW_REMOTE=false` (mặc định) từ chối mọi lệnh ghi bằng `ack {"ok":false,"err":"remote_disabled"}`, vẫn cho đọc; giới hạn `SCADA_REMOTE_RATE` (5 lệnh/s); payload ≤ 512 B.
2. **Web cục bộ `/scada`**: `operator` điều khiển, `viewer` chỉ xem; header `X-Requested-With` chống CSRF; khoá IP 5 phút sau 5 lần sai; mọi lệnh ghi vào nhật ký kèm tên người dùng.
3. Cả hai cùng đi qua bộ phân tích lệnh chỉ cho ghi D3, D4, D6, D7, D9 (0–65535) và đọc tối đa 60 thanh ghi.
Khoá liên động an toàn (E-stop, đủ số lượng) vẫn nằm trong PLC.

## Grafana
Dashboard "Giám sát PLC" được provision sẵn (`edge/grafana/dashboards/plciot.json`, sinh từ `tools/gen_grafana.py`): trạng thái PLC/băng tải/chế độ, đếm, mục tiêu, sản lượng theo giờ, tốc độ, timeline X/Y, cảnh báo, thời gian chạy. Dữ liệu `plc` và `plc_status` được Node-RED ghi mỗi 2 s (`--influx-every`); `--no-influx` để tắt. Grafana chỉ **xem**; điều khiển dùng `/scada`.

## Kiểm thử đã làm / chưa làm
- `tools/edge_e2e.js` chạy với Node-RED thật + broker thử + PLC Modbus giả: telemetry/history/status lên MQTT, cổng điều khiển từ xa **tắt và bật**, whitelist, đọc từ xa, `/scada` (401, viewer, operator, CSRF, nhật ký), Modbus server (đọc khớp telemetry, từ chối ghi, địa chỉ ngoài vùng). Tất cả đạt.
- Mọi luồng giao thức đã nạp vào Node-RED thật; các node khởi tạo, chỉ báo lỗi kết nối do không có PLC/InfluxDB (đúng dự kiến).
- **Chưa chạy**: Docker compose (máy dev không có Docker), ghi InfluxDB và dashboard Grafana thực tế, các PLC thật, OPC UA (cả client lẫn server).
- Giữ mật khẩu MQTT/InfluxDB trong `edge/data/flows_cred.json` và `edge/.env` ngoài git (đã có trong `.gitignore`). HTTP Basic của `/scada` và Grafana không mã hoá: dùng trong LAN tin cậy hoặc đặt reverse proxy TLS.
