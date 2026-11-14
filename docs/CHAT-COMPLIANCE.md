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
- Lưu lịch sử trao đổi/ chuyển khoản để đối soát. Chat KHÔNG tự xóa theo thời gian (`SUPPORT_RETENTION_DAYS=0`); mỗi người dùng giữ tối đa `SUPPORT_MAX_MESSAGES` tin (mặc định 200, tin cũ nhất bị xóa trước). Yêu cầu tư vấn đổi gói đang chờ lưu trong bảng `support_requests` (1/người dùng) tới khi admin Đồng ý/Từ chối.
- Thông báo bảo vệ dữ liệu cá nhân: nội dung chat là dữ liệu của người dùng, chỉ admin được phân quyền đọc.

## Điều cần xin ý kiến lại trước khi thêm tính năng
Nếu sau này muốn **thanh toán trong app, tự kích hoạt gói, hoặc hiển thị giá kèm nút mua**, đó là chức năng đặt hàng trực tuyến: phải làm thủ tục thông báo/đăng ký website thương mại điện tử với Bộ Công Thương **trước khi** bật tính năng.

## Cấu hình
```env
SUPPORT_DAILY_CAP=100          # tin người dùng gửi tối đa mỗi 24 giờ
SUPPORT_RETENTION_DAYS=0       # 0 = không xóa theo thời gian
SUPPORT_MAX_MESSAGES=200       # số tin tối đa / người dùng
SUPPORT_IMAGE_DAILY=20         # ảnh người dùng gửi tối đa mỗi 24 giờ
SUPPORT_IMAGE_MAX_BYTES=2097152
```

## Ảnh chụp màn hình
Người dùng (và admin) gửi được ảnh trong chat: nút 📷 hoặc dán ảnh vào ô nhập. Ảnh được thu nhỏ và vẽ lại bằng canvas ở trình duyệt (xoá EXIF), chỉ nhận JPEG/PNG đúng định dạng, tối đa 2 MB; chỉ chủ cuộc trò chuyện và admin xem được; tự xóa cùng tin nhắn. Ảnh biên lai chuyển khoản gửi qua chat vẫn là liên lạc thủ công, hợp lệ như hướng dẫn ở trên. Nhắc người dùng che thông tin nhạy cảm (mật khẩu, mã OTP, số thẻ) trước khi gửi.


## Lưu trữ & chống đầy DB

**Ba lớp lưu trữ**

| Lớp | Nơi | Quy tắc |
|---|---|---|
| Hiển thị | `support_messages` | `SUPPORT_MAX_MESSAGES` (200) tin gần nhất / người dùng |
| Lưu trữ | `support_archive` | Tin cũ hơn được **chuyển** sang (không xoá), tối đa `SUPPORT_ARCHIVE_MAX` (5000) / người dùng. Xem qua nút "Tin cũ hơn" (người dùng + admin) |
| Sao lưu | `data/backups/app-auto-YYYYMMDD.db` | Mỗi ngày 1 bản (`db.backup`, an toàn khi đang ghi), giữ 7 bản ngày + 4 bản tuần. Bản **ngoài VPS**: `cloud/scripts/pull-backup.ps1` (chạy trên PC, nên đặt lịch hằng tuần) |

- Admin xuất cả hội thoại (gồm kho lưu trữ) bằng nút "Xuất hội thoại" (`/api/admin/support/threads/:uid/export`, có ghi audit `support_export`).
- Yêu cầu tư vấn đổi gói chờ xử lý: bảng `support_requests` (1/người dùng), xoá khi admin Đồng ý/Từ chối.
- Xoá tài khoản (`purgeUserAccount`) xoá luôn `support_messages/archive/images/requests` của người đó. Nếu kế toán yêu cầu giữ ảnh chuyển khoản, hãy xuất trước khi xoá.
- Trên máy người dùng: bộ nhớ đệm IndexedDB `plciot-chat-<id>` (tối đa 200 tin, chỉ chữ; máy chủ vẫn là nguồn sự thật), tự xoá khi đăng xuất.
- File sao lưu chứa băm mật khẩu và bí mật TOTP: quyền 0600, giữ ở nơi được mã hoá, không chia sẻ.

**Chống spam / làm đầy DB** (đều đặt được bằng biến môi trường, xem `cloud/docker-compose.yml`)

- Giới hạn tốc độ: 8 tin/phút/người dùng, 6 ảnh/phút, `SUPPORT_IP_PER_MIN` (30) mỗi IP (chặn nhiều tài khoản từ một IP), `SUPPORT_GLOBAL_PER_MIN` (300) toàn cục (cầu dao khi bị tấn công phân tán). Trần/ngày: `SUPPORT_DAILY_CAP` (100 tin), `SUPPORT_IMAGE_DAILY` (20 ảnh).
- Chặn tin giống hệt trong 60 giây (`duplicate`). Mã gửi `cid` do client sinh: gửi lại khi rớt mạng không tạo tin trùng.
- Ảnh: chỉ JPEG/PNG đúng byte đầu tệp, tối đa 2 MB; `SUPPORT_USER_IMAGE_BYTES` (30 MB) / người dùng; `SUPPORT_GLOBAL_IMAGE_BYTES` (1 GB) và `SUPPORT_GLOBAL_MESSAGES` (300000) toàn hệ thống → vượt thì trả `busy` (503) cho tin/ảnh mới, chat cũ vẫn xem được. `SUPPORT_IMAGE_ARCHIVE_DAYS` (730): ảnh quá hạn bị xoá, tin chữ vẫn giữ.
- Mọi endpoint chat đều yêu cầu đăng nhập (không có endpoint ẩn danh làm đầy DB). Tấn công cấp mạng (DDoS) do Cloudflare chặn ở phía trước; tầng ứng dụng chỉ giữ giới hạn tốc độ như trên.
