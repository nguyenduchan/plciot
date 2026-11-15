# Gateway cho giải pháp "Nông nghiệp nhà kính"

`setup.json` là bản khai thiết bị + field mà giao diện cần (ghép cặp: gửi làm `config`).

Giao diện gateway là DỮ LIỆU: `ui.json` (bảng màu + khối hiển thị + công thức). Admin gán giải pháp cho gateway khi phát mã ghép cặp; server gửi `ui.json` trong kit lúc Enroll, GatewayApp (một bản dùng chung) lưu cache và áp dụng khi mở lại. Không cần build riêng.

**Field bắt buộc:** temp, hum, soil

Nhiệt độ, độ ẩm khí và độ ẩm đất quyết định tưới/thông gió; thiếu một trong ba, khối vùng trồng không đánh giá được.
