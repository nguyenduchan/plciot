# Quy ước giao diện giám sát / điều khiển từ xa

Tài liệu này ghi lại các yêu cầu giao diện đã chốt cho app giám sát PLC để **áp dụng lại khi viết dashboard cho người dùng khác**.
Code tham chiếu: `webapp/style.css` (màu, phông, nút, thẻ trạng thái), `webapp/app.js` (chỉ báo dữ liệu cũ, xác nhận lệnh, sự kiện),
`webapp/index.html`. Trang đăng nhập dùng chung: `packages/security/README.md`.

## 1. Chọn kiểu theo người dùng

| | **Vận hành** (kỹ sư, người ngồi phòng điều khiển) | **Đơn giản** (chủ xưởng, cá nhân, xem bằng điện thoại) |
|---|---|---|
| Màu bình thường | Trắng / xám / đen, **gần như không màu** | Nền trung tính + **một màu nhấn**; xanh lá cho "ổn" |
| Màu trạng thái | Chỉ khi cảnh báo / lỗi | Xanh = ổn, hổ phách = cảnh báo, đỏ = lỗi (luôn kèm biểu tượng + chữ) |
| Chỉ số | Nhiều (đầu vào, đầu ra, địa chỉ X/Y, truy vấn thanh ghi) | Ít; ẩn phần kỹ thuật |
| Tên | Theo địa chỉ (Y0, X3) | Đời thường ("Thiết bị 1", "Băng tải 1") |
| Cảnh báo | Thanh cố định + "Đã nhận" | Thẻ trạng thái lớn có **gợi ý cách xử lý** + thông báo đẩy |

Cài đặt "Kiểu giao diện" (`cfg.uiMode`: `simple` | `pro`, mặc định `simple`). Hai kiểu dùng chung dữ liệu và chức năng, chỉ đổi mật độ, ngôn ngữ và dùng màu.

## 2. Quy tắc màu (ISA-101)
1. Bình thường: ít màu, để khi có lỗi thì màu nổi bật ngay. Mỗi màu chỉ có **một nghĩa** trong toàn hệ thống.
2. Đỏ = báo động khẩn cấp / lỗi; hổ phách = cảnh báo / mất liên lạc; xanh lá chỉ ở kiểu Đơn giản cho "máy ổn".
3. **Không dựa vào màu một mình**: luôn kèm biểu tượng (▲ ■ ● ✔) và chữ, để người mù màu nhận ra.
4. Biểu đồ nhiều đường: màu hoặc kiểu nét phân biệt, tránh đỏ và hổ phách (dành cho cảnh báo).
5. Nhấn nút chính bằng **đảo màu** (nền đậm, chữ sáng), không thêm màu mới ở kiểu Vận hành.
6. Có chế độ **sáng và tối** theo cài đặt máy; nền sáng tương phản cao để đọc ngoài trời.

## 3. Phông chữ
- Phông hệ thống, **không tải font ngoài** (chạy offline, nhanh, hợp từng hệ điều hành):
  `"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"SF Pro Text",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif`.
- Số: `font-variant-numeric: tabular-nums slashed-zero` (chữ số đều bề rộng, số 0 gạch chéo để không nhầm 0/O).
- Địa chỉ, giờ, mã: phông đơn cách `ui-monospace,"SF Mono","Cascadia Mono","Roboto Mono",Consolas,monospace`.
- Muốn đồng nhất mọi hệ điều hành thì tự chứa (self-host) Inter + Roboto Mono; chỉ tải sau khi được đồng ý.

## 4. Độ tin cậy của dữ liệu
- Luôn hiện **kết nối** (trực tuyến / mất kết nối / PLC mất liên lạc) và **"cập nhật N giây trước"**.
- Quá `STALE_MS` (15 giây) không có dữ liệu mới: đổi chỉ báo thành "Dữ liệu cũ", thanh cảnh báo ghi "số liệu không còn đáng tin" kèm giờ nhận dữ liệu lần cuối, và **làm mờ các số** (`body.stale`). Không bao giờ hiện "0 / Đã dừng" khi thực ra là mất kết nối.

## 5. Điều khiển an toàn
- Nút khả dụng = đậm, to (`.ctl-btn.act`, cao tối thiểu 56 px); nút không khả dụng = viền đứt mờ (`.idle`). Khi máy đang chạy, **"Dừng máy" là nút nổi bật nhất**.
- Mọi hành động tác động vật lý (chạy, dừng, đổi chế độ, bật/tắt đầu ra) có **hộp xác nhận** nói rõ hậu quả (`confirmAction`).
- Phản hồi: "Đã gửi lệnh, chờ PLC xác nhận…" rồi "PLC đã xác nhận" / "PLC từ chối" / "PLC không phản hồi". Không đổi giao diện trước khi PLC xác nhận. Mọi kết quả ghi vào **Sự kiện gần nhất**.
- Công tắc đầu ra: tên thiết bị (người dùng đặt được), trạng thái bằng **chữ BẬT/TẮT** chứ không chỉ gạt công tắc; chạm đủ lớn.
- Nút dừng khẩn cấp luôn ở vị trí cố định (nếu thêm).

## 6. Cảnh báo
- Hai mức: **khẩn cấp** (đỏ) và **cảnh báo** (hổ phách). Mỗi cảnh báo có tên, **cách xử lý** ngắn, thời điểm.
- Thanh cảnh báo dính ở đầu mọi tab; chưa "Đã nhận" thì nhấp nháy (tôn trọng `prefers-reduced-motion`).
- Kiểu Đơn giản: **thẻ trạng thái lớn** đầu trang trả lời "máy có ổn không?" bằng một câu.
- **Thông báo đẩy** (Telegram/email) khi cảnh báo mới xuất hiện và khi hết (server `mqttIngest.js`, tối đa 1 tin cảnh báo mới/60 giây/thiết bị). Chủ xưởng không ngồi nhìn app cả ngày.
- Danh sách **sự kiện gần nhất** (cảnh báo xuất hiện/hết, lệnh của người dùng + kết quả, mất/khôi phục kết nối) thay cho khoảng trống biểu đồ.

## 7. Bố cục và điện thoại
- Mobile-first, thanh điều hướng dưới cùng, nút ≥ 48 px, một cột; từ 900 px thành thanh bên + hai cột.
- Biểu đồ chưa có dữ liệu thì thu gọn, không chiếm khung.
- Chuẩn dashboard dài hạn (so sánh nhiều tuần/tháng): dùng Grafana cho phân tích, giữ app riêng cho vận hành và điều khiển.

## 8. Ngôn ngữ
- Kiểu Đơn giản: tiếng đời thường ("Băng tải đang dừng", không "Y0 TẮT"), gợi ý hành động khi có lỗi.
- Kiểu Vận hành: được dùng thuật ngữ PLC, địa chỉ thanh ghi.

## 9. Đăng nhập (xem README của gói bảo mật)
- Máy chưa xác nhận OTP: chỉ nhập số điện thoại → OTP. Sau OTP mới tới Face ID / vân tay, rồi mật khẩu.
- Máy đã tin cậy (vd. sau đăng xuất): chỉ Face ID hoặc mật khẩu cho số đã đăng nhập, ghi rõ "bằng Face ID / mật khẩu".
- Face ID luôn hỏi server trước (máy chưa tin cậy thì không bắt quét Face ID rồi mới báo cần OTP).

## 10. Danh sách kiểm tra khi viết dashboard mới
- [ ] Chọn kiểu giao diện theo người dùng (Vận hành / Đơn giản), có cài đặt chuyển.
- [ ] Mọi trạng thái có biểu tượng + chữ, không chỉ màu.
- [ ] Chỉ báo kết nối + "N giây trước"; số bị làm mờ khi dữ liệu cũ.
- [ ] Nút nguy hiểm có xác nhận và phản hồi sau khi gửi.
- [ ] Thiết bị có tên thật, không chỉ địa chỉ.
- [ ] Cảnh báo có mức, cách xử lý, thông báo đẩy; có danh sách sự kiện.
- [ ] Phông hệ thống, số tabular + slashed-zero.
- [ ] Kiểm tra sáng / tối, 375 px và ≥ 900 px, ánh nắng ngoài trời.
