# Chat hỗ trợ & hướng dẫn thanh toán thủ công

> Đây là hướng dẫn vận hành do dự án tự soạn, **không phải tư vấn pháp lý/thuế**. Trước khi thu tiền thật, hãy hỏi kế toán/luật sư hoặc Sở Công Thương địa phương để chốt cách áp dụng cho tư cách pháp lý của bạn (cá nhân, hộ kinh doanh, công ty).

## Nguyên tắc: chat chỉ là kênh liên lạc, không phải hệ thống bán hàng
Quy định thương mại điện tử (Nghị định 52/2013/NĐ-CP, 85/2021/NĐ-CP) nhắm vào website/app có **chức năng đặt hàng trực tuyến**. Kênh chat ở đây được thiết kế để **không** có chức năng đó:

| Có | Không có (và không được thêm) |
|---|---|
| Nhắn tin văn bản giữa người dùng và admin | Nút "Mua / Đặt gói / Xác nhận mua / Thanh toán" trong app hay trong chat |
| Admin tự gõ tư vấn, giá, hướng dẫn chuyển khoản | Giỏ hàng, tạo đơn, mã đơn hàng tự sinh |
| Admin gán gói thủ công sau khi tự kiểm tra tiền về | Cổng thanh toán (VNPay/MoMo/PayOS…), link thanh toán, QR động có sẵn số tiền + nội dung |
| Mẫu tin nhắn: chỉ **điền sẵn chữ** vào ô soạn, admin tự chỉnh rồi bấm Gửi | Webhook ngân hàng / tự động kích hoạt gói khi có tiền |
| | Bảng giá kèm nút mua trong app; ghi nhận thanh toán trong CSDL |

Triển khai tương ứng trong code: `cloud/app/src/supportChat.js` (chỉ có API nhắn tin; **không** có endpoint đơn hàng/thanh toán, test `smoke-admin-site.js` kiểm tra điều này), giao diện hiển thị bằng `textContent` (không tự biến chữ thành link/nút), các nút trong app dùng chữ **"Chat để nâng cấp"** (không dùng "Mua ngay/Đặt hàng"). Trang bảng gói trong app **không có giá**.

## Quy trình thanh toán thủ công (admin)
1. Người dùng bấm **Chat để nâng cấp** (Cài đặt → Hỗ trợ & nâng cấp gói) — chỉ điền sẵn lời nhắn, người dùng tự gửi.
2. Admin mở **adminplc.dieukhientudong.net → Hỗ trợ**, tư vấn gói phù hợp và **thỏa thuận giá bằng tin nhắn**.
3. Admin chọn mẫu **"Hướng dẫn chuyển khoản thủ công"**, tự điền ngân hàng/số tài khoản/số tiền rồi gửi. **Nội dung chuyển khoản chỉ gồm `tên đăng nhập + gói`** (hệ thống không giữ họ tên/SĐT của người dùng nên không yêu cầu); admin dựa vào đó để đối soát. Người dùng **tự mở app ngân hàng của họ** và tự nhập thông tin (không có QR/link do hệ thống sinh, không có mã đơn hàng).
4. Người dùng nhắn lại xác nhận (ngày giờ, số tiền). Admin **tự kiểm tra tài khoản ngân hàng** thấy tiền về.
5. Admin gán gói thủ công: **Console → Gói / Subscribe** (hoặc `node scripts/plan.js grant …`), rồi nhắn mẫu **"Đã nhận tiền, đã nâng gói"**.
6. Nếu người mua yêu cầu hóa đơn: dùng mẫu **"Hóa đơn (chỉ khi người mua yêu cầu)"** để xin thông tin ghi trên hóa đơn, xuất hóa đơn ngoài hệ thống. Hệ thống không thu thập thông tin cá nhân của người dùng ngoài tên đăng nhập; chỉ xin khi họ tự muốn lấy hóa đơn. Cách lập hóa đơn khi người mua không cung cấp thông tin: hỏi kế toán.

Không đưa vào chat: mật khẩu, mã Authenticator, số thẻ, mã OTP. Không yêu cầu người dùng gửi những thứ này.

## Việc ngoài phần mềm (vẫn bắt buộc)
- **Kê khai doanh thu và nộp thuế** (GTGT/TNCN/TNDN tùy tư cách) cho mọi khoản thu từ bán gói.
- **Lập hóa đơn điện tử** theo quy định hiện hành khi cung cấp dịch vụ và nhận tiền (hỏi kế toán về thời điểm và loại hóa đơn).
- Lưu lịch sử trao đổi/ chuyển khoản để đối soát. Chat tự xóa sau `SUPPORT_RETENTION_DAYS` (mặc định 365 ngày); nếu cần giữ lâu hơn cho kế toán, tăng giá trị này.
- Thông báo bảo vệ dữ liệu cá nhân: nội dung chat là dữ liệu của người dùng, chỉ admin được phân quyền đọc.

## Điều cần xin ý kiến lại trước khi thêm tính năng
Nếu sau này muốn **thanh toán trong app, tự kích hoạt gói, hoặc hiển thị giá kèm nút mua**, đó là chức năng đặt hàng trực tuyến: phải làm thủ tục thông báo/đăng ký website thương mại điện tử với Bộ Công Thương **trước khi** bật tính năng.

## Cấu hình
```env
SUPPORT_DAILY_CAP=100          # tin người dùng gửi tối đa mỗi 24 giờ
SUPPORT_RETENTION_DAYS=365     # tự xóa tin cũ (kể cả ảnh)
SUPPORT_IMAGE_DAILY=20         # ảnh người dùng gửi tối đa mỗi 24 giờ
SUPPORT_IMAGE_MAX_BYTES=2097152
```

## Ảnh chụp màn hình
Người dùng (và admin) gửi được ảnh trong chat: nút 📷 hoặc dán ảnh vào ô nhập. Ảnh được thu nhỏ và vẽ lại bằng canvas ở trình duyệt (xoá EXIF), chỉ nhận JPEG/PNG đúng định dạng, tối đa 2 MB; chỉ chủ cuộc trò chuyện và admin xem được; tự xóa cùng tin nhắn. Ảnh biên lai chuyển khoản gửi qua chat vẫn là liên lạc thủ công, hợp lệ như hướng dẫn ở trên. Nhắc người dùng che thông tin nhạy cảm (mật khẩu, mã OTP, số thẻ) trước khi gửi.
