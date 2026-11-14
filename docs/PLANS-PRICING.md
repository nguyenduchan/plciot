# Gói dịch vụ và gợi ý giá (xưởng vừa/nhỏ, trạm bơm tại Việt Nam)

Mọi gói đều có **giám sát + điều khiển**; các gói khác nhau về số widget, độ mịn và thời gian lưu lịch sử. Giá chỉ là **gợi ý cho admin** (khung "Xử lý yêu cầu đổi gói"), **không hiện trong app người dùng**, không tạo đơn, không thanh toán (xem `CHAT-COMPLIANCE.md`).

| Gói | Dành cho | Widget tối đa | Lịch sử | Gợi ý giá (chưa VAT) |
|---|---|---|---|---|
| **Miễn phí** | Dùng thử, 1 trạm bơm nhỏ | 5 | 1 mẫu/2 giây, lưu 1 ngày | 0đ |
| **Cơ bản** | Trạm bơm, xưởng nhỏ | 30 | 1 mẫu/10 giây, lưu 7 ngày | 99.000đ/tháng trọn gói (~1.188.000đ/năm) |
| **Nâng cao** | Xưởng vừa, nhiều trạm, cần xem lại cả tháng | 100 | 1 mẫu/10 giây, lưu 30 ngày | 8.000đ/widget/tháng, tối thiểu 199.000đ/tháng |
| **Nhà máy / partner** | Hệ thống lớn, lưu dài hạn | 300 | chi tiết 30 ngày, sau đó 1 mẫu/5 phút đủ 10 năm | **Trả một lần cho 10 năm** ≈ 1.910.000đ/widget (3 × chi phí vận hành 10 năm) |

Ví dụ thực tế: trạm bơm 6–10 widget → gói Cơ bản 99.000đ/tháng; xưởng 25 widget cần xem lại báo cáo cả tháng → Nâng cao 199.000đ/tháng; hệ thống 11 widget muốn trả một lần cho 10 năm → ~21 triệu (≈175.000đ/tháng).

## Cách tính giá sàn (đo thật trên VPS 2 CPU / 2 GB, 260.000đ/tháng)

- Đo bằng `cloud/app/scripts/bench-capacity.js`: mỗi widget 1 tin/giây, CPU còn dư rất nhiều (≥ 4.000 widget), **đĩa là giới hạn thật**: ~252 byte/dòng trong DB.
- Mỗi widget chiếm đĩa = số dòng × 252 byte. Số dòng: Miễn phí 43.200; Cơ bản 60.480; Nâng cao 259.200; Nhà máy 259.200 (30 ngày chi tiết) + 1.042.560 (gộp 1 mẫu/5 phút trong 3.620 ngày) ≈ 1,30 triệu dòng ≈ **313 MiB**.
- Phần chi phí 1 widget = chi phí VPS × (đĩa của widget ÷ 15 GB đĩa dùng được); lấy giá trị lớn hơn giữa phần đĩa và phần CPU (1/1.500 sức chứa an toàn).
- Giá sàn/widget/tháng: Cơ bản ~246đ, Nâng cao ~1.054đ, Nhà máy ~5.296đ.
- **Nhà máy trả một lần** = giá sàn 10 năm × 3, làm tròn lên 10.000đ. Giá niêm yết Cơ bản/Nâng cao cao hơn giá sàn nhiều lần vì còn phải trả công hỗ trợ, thuế và rủi ro.

Tất cả có thể đặt lại bằng biến môi trường: `PRICING_VPS_VND_MONTH`, `PRICING_DISK_USABLE_GB`, `PRICING_BYTES_PER_ROW`, `PRICING_CPU_CAPACITY_WIDGETS`, `PRICE_BASIC_MONTH`, `PRICE_PRO_PER_WIDGET_MONTH`, `PRICE_PRO_MIN_MONTH`. Nếu nâng VPS lên 600.000đ/tháng thì đổi `PRICING_VPS_VND_MONTH` (và `PRICING_DISK_USABLE_GB` nếu đĩa lớn hơn).

## Phần mềm thực hiện

- `entitlements.js` (`PLAN_CATALOG`): widget tối đa, `telemetryMinMs` (khoảng cách tối thiểu giữa hai mẫu lịch sử), thời gian lưu. Chỉ **lịch sử lưu DB** thưa đi; xem trực tiếp trên app vẫn theo thời gian thực.
- `retention.js` → `thinOldTelemetry`: mỗi giờ gộp telemetry cũ hơn 30 ngày của gói không giới hạn còn 1 mẫu/5 phút (`smoke-thin.js`).
- `pricing.js`: tính gợi ý giá; admin chọn gói là thấy giá và có nút điền sẵn vào ô soạn.
- Tài khoản đã được gán gói trước đây giữ nguyên số ngày lưu đã ghi lúc gán; gán lại gói để áp dụng thời gian lưu mới (Cơ bản 7 ngày).
