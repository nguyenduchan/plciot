# Gateway cho giải pháp "Sản xuất & OEE"

`setup.json` là bản khai thiết bị + field mà giao diện cần (ghép cặp: gửi làm `config`).

Giao diện gateway là DỮ LIỆU: `ui.json` (bảng màu + khối hiển thị + công thức). Admin gán giải pháp cho gateway khi phát mã ghép cặp; server gửi `ui.json` trong kit lúc Enroll, GatewayApp (một bản dùng chung) lưu cache và áp dụng khi mở lại. Không cần build riêng.

**Field bắt buộc:** state, count

Trạng thái máy và bộ đếm sản phẩm là nền để tính OEE; avail/perf/qual nếu có thì hiện vòng chi tiết.
