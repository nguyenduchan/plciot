# Giải pháp: Conveyor (tham chiếu, giao diện WPF)

> Bộ nhớ của giải pháp cho người và LLM. Ghi yêu cầu/quyết định TRƯỚC khi sửa mã.

## Khách hàng / thiết bị
- Dây chuyền băng tải đếm sản phẩm, PLC Xinje XD3-16T-E qua Modbus TCP (`plc/xd3_logic.st`), bản đồ thanh ghi: `docs/PROTOCOL.md`.

## Quyết định chế độ (khớp `ConveyorSolution.cs`)
| Mục | Giá trị | Lý do |
|---|---|---|
| Số màn hình | MỘT màn hình trên máy chính (`UseSingleScreen`) | điều khiển trực tiếp, không client-server |
| Màn hình phụ | không | |
| Điện thoại | Off mặc định; `Enforce` không cho `Control` (tối đa MonitorOnly) | khách hàng không cho điều khiển từ điện thoại |
| Thanh ghi ghi được | D3 chế độ, D4 mặt nạ Y, D6 chạy/dừng, D7 mục tiêu, D9 xoá đếm | khớp whitelist gateway |

## Giao diện (WPF, `MainWindow`)
- Giám sát / Điều khiển / Nhật ký / Cài đặt (chỉ thông số hiện trường: site, PLC, cloud). Chế độ do giải pháp khoá, hiển thị ở đầu tab Cài đặt.
- Quyền điều khiển lấy từ `IScadaView.CanControl`; đổi quyền bằng `ConveyorSolution`, không sửa cửa sổ.

## Chưa kiểm chứng
- Cửa sổ WPF khi chạy thật (mới build); PLC thật.

## Lịch sử thay đổi
- Tách từ ứng dụng WPF cũ (`Plciot.Scada.App`) thành giải pháp riêng trên framework.
