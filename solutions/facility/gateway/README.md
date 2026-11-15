# Gateway cho giải pháp "Mặt bằng nhà máy"

`setup.json` là bản khai thiết bị + field mà giao diện cần (ghép cặp: gửi làm `config`).

Giao diện gateway là DỮ LIỆU: `ui.json` (bảng màu + khối hiển thị + công thức). Admin gán giải pháp cho gateway khi phát mã ghép cặp; server gửi `ui.json` trong kit lúc Enroll, GatewayApp (một bản dùng chung) lưu cache và áp dụng khi mở lại. Không cần build riêng.

**Field bắt buộc:** temp, gas

Nhiệt độ và khí gas để cảnh báo cháy nổ theo vị trí; mỗi cảm biến là một thiết bị khớp vị trí trên mặt bằng (n1…n6).
