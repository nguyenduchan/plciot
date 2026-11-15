# Gateway cho giải pháp "Giám sát điện năng 3 pha"

`setup.json` là bản khai thiết bị + field mà giao diện cần (ghép cặp: gửi làm `config`).

Giao diện gateway là DỮ LIỆU: `ui.json` (bảng màu + khối hiển thị + công thức). Admin gán giải pháp cho gateway khi phát mã ghép cặp; server gửi `ui.json` trong kit lúc Enroll, GatewayApp (một bản dùng chung) lưu cache và áp dụng khi mở lại. Không cần build riêng.

**Field bắt buộc:** kw, pf, v1, i1

Công suất, hệ số công suất, điện áp và dòng pha là tối thiểu để đánh giá chất lượng điện.
