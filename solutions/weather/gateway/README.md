# Gateway cho giải pháp "Trạm khí tượng & thủy văn"

`setup.json` là bản khai thiết bị + field mà giao diện cần (ghép cặp: gửi làm `config`).

Giao diện gateway là DỮ LIỆU: `ui.json` (bảng màu + khối hiển thị + công thức). Admin gán giải pháp cho gateway khi phát mã ghép cặp; server gửi `ui.json` trong kit lúc Enroll, GatewayApp (một bản dùng chung) lưu cache và áp dụng khi mở lại. Không cần build riêng.

**Field bắt buộc:** wd, ws, rain, level

Hướng + tốc độ gió, lượng mưa và mực nước sông là bộ tối thiểu của trạm khí tượng thủy văn.
