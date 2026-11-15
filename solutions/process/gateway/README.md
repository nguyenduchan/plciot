# Gateway cho giải pháp "Quy trình pha chế (P&ID)"

`setup.json` là bản khai thiết bị + field mà giao diện cần (ghép cặp: gửi làm `config`).

Giao diện gateway là DỮ LIỆU: `ui.json` (bảng màu + khối hiển thị + công thức). Admin gán giải pháp cho gateway khi phát mã ghép cặp; server gửi `ui.json` trong kit lúc Enroll, GatewayApp (một bản dùng chung) lưu cache và áp dụng khi mở lại. Không cần build riêng.

**Field bắt buộc:** la, lb, lc, temp, p1, p2

Sơ đồ P&ID cần đủ mức 3 bồn, nhiệt độ bình và trạng thái hai bơm để vẽ dòng chảy đúng.
