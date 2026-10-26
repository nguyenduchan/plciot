# Giải pháp: Template (đổi tên theo khách hàng)

> File này là **bộ nhớ của giải pháp** cho người và cho LLM sửa về sau. Ghi mọi yêu cầu/quyết định của khách hàng ở đây TRƯỚC khi sửa mã.

## Khách hàng / nhà máy
- Tên, địa điểm, người liên hệ:
- Thiết bị: PLC hãng/model, giao thức (Modbus TCP / S7 / …), địa chỉ IP:

## Quyết định chế độ (khớp với `TemplateSolution.cs`)
| Mục | Giá trị | Lý do |
|---|---|---|
| Số màn hình | MỘT màn hình (`UseSingleScreen`) | |
| Màn hình phụ | không có | |
| Điện thoại | Off (đổi MonitorOnly khi có cloud) | |
| Thanh ghi ghi được | D3, D4, D6, D7, D9 | |

## Logic riêng (thư mục `Modules/`)
- `TargetReachedLogModule`: ghi nhật ký khi đủ số lượng (ví dụ).

## Lịch sử thay đổi
- (ngày) (người/LLM) mô tả, file đã sửa.
