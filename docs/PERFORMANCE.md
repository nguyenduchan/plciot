# Đo hiệu năng: SCADA C# và Node-RED (web-based)

Cùng một máy (Windows 11), cùng PLC Modbus TCP giả (`tools/perf_bench.js harness`), vòng đọc 0,2 s, đẩy telemetry lên một broker MQTT thử, cùng bộ tạo tải. **C#**: `Plciot.Scada.Host` bản Release. **Node-RED**: 4.1 chạy trên Node 18 của máy dev (bản Docker dùng Node 22, nhanh hơn một chút). Chạy lại: xem đầu `tools/perf_bench.js`.

| Chỉ số | C# Host | Node-RED |
|---|---|---|
| Chạy nền, đọc 5 Hz + đẩy cloud | CPU 0,5 % · RAM 77 MB | CPU 3,9 % · RAM 130 MB |
| Lệnh điều khiển từ MQTT → PLC (p50 / p95) | 6 / 9 ms (qua TLS) | 28 / 44 ms (MQTT thường) |
| PLC đổi → telemetry tới MQTT (p50 / p95) | 67 / 252 ms* | 40 / 76 ms |
| Web trạng thái, 1 kết nối | 2 725 req/s · p50 0,3 ms | 138 req/s · p50 6,3 ms |
| Web trạng thái, 10 kết nối | 5 686 req/s · p50 1,2 ms | 285 req/s · p50 33 ms |
| Web trạng thái, 50 kết nối | 2 879 req/s · p50 7 ms | 353 req/s · p50 140 ms |
| Server Modbus TCP (40 thanh ghi), 10 client | 8 648 req/s · p50 0,9 ms | 1 037 req/s · p50 7,4 ms |
| Server Modbus TCP, 50 client | 6 799 req/s (tối đa 20 client, còn lại bị từ chối) | 2 003 req/s |
| RAM sau tải | 79 MB | 313 MB |
| **Điều khiển tại máy (giao diện → PLC)** | **0,85 ms p50 / 1,9 ms p95** (ghi Modbus thô: 0,69 / 1,3 ms) | không áp dụng: Node-RED đi qua trang `/scada` + MQTT |

\* Bản C# gộp telemetry lên cloud tối thiểu 200 ms (`CloudTelemetryMinMs`, bằng chu kỳ đọc nên số gói bằng Node-RED); đặt 0–50 ms nếu cần giảm độ trễ này. Node-RED gửi mỗi lần đọc.

## Điều khiển trực tiếp trong C#
Giao diện gọi `IScadaView.WriteAsync` → `ScadaCore.ExecuteAsync` → driver PLC: không broker, không HTTP, không hàng đợi. Sau khi ghi, lõi đọc lại ngay (không chờ hết chu kỳ), nên giao diện thấy giá trị mới trong vài mili-giây. Phần thêm của lõi (kiểm tra whitelist, ack, nhật ký) ≈ 0,15 ms so với ghi Modbus thô. Chạy lại: `dotnet test tests/Plciot.Scada.Tests --filter Category=Perf -v n`.

## Lưu ý khi đọc số liệu
- Máy phát tải, PLC giả, broker và phần mềm được đo cùng chạy một máy: số tuyệt đối thấp hơn máy chuyên dụng; so sánh hai cột với nhau mới có ý nghĩa. Bộ tạo tải là Node đơn luồng nên các con số ~6–9k req/s gần mức tối đa của chính nó (cận dưới của server).
- Cột C# gửi telemetry qua TLS tới broker thử; cột Node-RED qua MQTT không mã hoá (chi phí TLS nằm ở C#).
- Giới hạn có chủ đích: web C# tối đa 100 kết nối đồng thời, server Modbus 20 client, đều có thể đổi trong mã.
- RAM Node-RED tăng khi tải web/Modbus lớn (130 → 313 MB) và không giảm ngay sau tải; container nên đặt `mem_limit` ≥ 512 MB (đã đặt trong `edge/docker-compose.yml`).
- Chưa đo: PLC thật, InfluxDB/Grafana, OPC UA, nhiều giờ liên tục (rò rỉ bộ nhớ dài hạn), CPU yếu (mini PC/Raspberry Pi).
