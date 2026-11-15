# Gateway cho giải pháp "Bồn bể xăng dầu & hóa chất"

`setup.json` là bản khai thiết bị + field mà giao diện cần (ghép cặp: gửi làm `config`).

Giao diện gateway là DỮ LIỆU: `ui.json` (bảng màu + khối hiển thị + công thức). Admin gán giải pháp cho gateway khi phát mã ghép cặp; server gửi `ui.json` trong kit lúc Enroll, GatewayApp (một bản dùng chung) lưu cache và áp dụng khi mở lại. Không cần build riêng.

**Field bắt buộc:** level, leak

Mức bồn và tín hiệu rò rỉ là yêu cầu an toàn bắt buộc với bồn xăng dầu/hóa chất.
