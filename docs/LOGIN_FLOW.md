# Quy trình đăng nhập / đăng ký (3 bước)

Tài liệu này là **nguồn chuẩn** của luồng đăng nhập webapp. Code ở `webapp/security/login.js`, `webapp/security/security-client.js`
(bản chuẩn: `packages/security/client/`) và `packages/security/src/flows.js`, `routes.js`.

## 1. Quy trình theo yêu cầu

Một luồng duy nhất cho đăng nhập và đăng ký: người dùng chỉ nhập số điện thoại, hệ thống tự quyết định các bước.

**Bước 1: OTP Telegram**
- Máy (webapp) **chưa từng** xác nhận OTP: bắt buộc đăng nhập OTP Telegram.
- Máy **đã** xác nhận OTP ở phiên trước: **ẩn** ô OTP, bỏ qua bước này.

**Bước 2: Face ID / vân tay**
- Kiểm tra điện thoại hỗ trợ Face ID. Có: hiện "Đăng nhập bằng Face ID".
- Không có Face ID: kiểm tra vân tay. Có: hiện "Đăng nhập bằng vân tay". Các bước sau giống Face ID.
- Đã đăng ký sinh trắc trên server: đăng nhập sinh trắc, rồi sang bước 3.
- Chưa đăng ký: **bắt buộc** đăng ký (tạo khoá, gửi **public key** lên server), rồi sang bước 3.
- Điện thoại không hỗ trợ Face ID lẫn vân tay: bỏ qua bước 2.

**Bước 3: Mật khẩu**
- Server **chưa có** mật khẩu: bắt buộc nhập mật khẩu + nhập lại, gửi lên server, rồi vào trang chính.
- Server **đã có** mật khẩu và điện thoại **không** hỗ trợ sinh trắc: chỉ nhập mật khẩu rồi vào trang chính.
- Server đã có mật khẩu và sinh trắc đã dùng ở bước 2: không hỏi lại mật khẩu.

**Tài khoản mới:** số điện thoại chưa tồn tại **luôn** phải qua OTP Telegram. Sau OTP đúng phải đăng ký **đủ** sinh trắc (nếu máy hỗ trợ; bước không hỗ trợ thì bỏ qua) **và** mật khẩu, hoàn tất tất cả mới vào trang chính. Tài khoản mới **không có lối thoát** "dùng mật khẩu thay thế". Server chặn nếu thiếu (`setup_incomplete`, `biometric_required`).

**Tài khoản đã đăng ký, máy đã xác nhận OTP:** hiện **tất cả** lựa chọn: sinh trắc, mật khẩu, OTP Telegram.

**Hạn:** mã OTP sống `OTP_CODE_TTL_SEC` (mặc định **180 giây**, 60 đến 600). Máy đã xác nhận OTP được tin cậy `OTP_TRUST_DAYS` (mặc định **30 ngày** từ lần OTP gần nhất, không tự gia hạn); quá hạn hoặc xoá dữ liệu trang thì phải OTP lại.

## 2. Bảng quyết định

Ký hiệu: **T** = máy đã xác nhận OTP (tin cậy), **B** = điện thoại hỗ trợ sinh trắc, **K** = server đã có khoá sinh trắc của tài khoản,
**P** = server đã có mật khẩu.

| T | B | K | P | Chuỗi bước | Vào trang chính khi |
|---|---|---|---|---|---|
| không | có | có | có | OTP, sinh trắc | OTP + sinh trắc |
| không | có | có | không | OTP, sinh trắc, đặt mật khẩu | OTP + sinh trắc + đặt mật khẩu |
| không | có | không | bất kỳ | OTP, đăng ký sinh trắc, (đặt mật khẩu nếu chưa có) | OTP + sinh trắc mới |
| không | không | bất kỳ | có | OTP, mật khẩu | OTP + mật khẩu |
| không | không | bất kỳ | không | OTP, đặt mật khẩu | OTP + mật khẩu mới (tạo tài khoản) |
| có | có | có | có | sinh trắc | sinh trắc |
| có | có | có | không | sinh trắc, đặt mật khẩu | sinh trắc + đặt mật khẩu |
| có | có | không | có | **mật khẩu**, rồi đăng ký sinh trắc | mật khẩu + sinh trắc mới (xem 3.4) |
| có | không | bất kỳ | có | mật khẩu | mật khẩu |

## 3. Review: điểm cần chốt và cách xử lý

1. **"Đã đăng nhập OTP" nghĩa là gì?** Là **thiết bị** đã xác nhận OTP trong vòng `OTP_TRUST_DAYS` (30 ngày), lưu ở server (`known_devices.otp_verified`
   và `otp_verified_at`, khoá theo mã thiết bị ngẫu nhiên trong trình duyệt), không phải cờ trên trình duyệt. Xoá dữ liệu trang đổi mã thiết bị, nên phải OTP lại. Máy đã có
   từ trước khi thêm cột được coi là đã tin cậy.
2. **Bỏ lối "mật khẩu + sinh trắc, không OTP" trên máy mới.** Luồng cũ cho phép; theo bước 1 mới thì máy chưa xác nhận OTP luôn phải OTP.
   Khôi phục khi mất Telegram vẫn dùng "Khôi phục 2 yếu tố" riêng (`/api/login/recover`).
3. **Không phân biệt chắc Face ID và vân tay.** Web không cho biết loại cảm biến. Dùng
   `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` để biết có sinh trắc, rồi đoán nhãn: iPhone màn hình dài (cạnh
   >= 812) là "Face ID", iPhone cạnh ngắn hơn và iPad là "Touch ID", Android là "vân tay", Windows là "Windows Hello". Nhãn chỉ là chữ hiển
   thị; luồng thực hiện giống nhau.
4. **Máy tin cậy, hỗ trợ sinh trắc nhưng chưa đăng ký khoá.** Đăng ký khoá là thêm yếu tố bảo mật nên phải xác thực trước. Thứ tự đảo
   cục bộ: nhập mật khẩu trước (đăng nhập "mới" trong 10 phút), rồi đăng ký sinh trắc, rồi vào trang chính. Không có mật khẩu và không có
   khoá thì tài khoản chưa hoàn tất, buộc OTP lại.
5. **Đăng ký sinh trắc thất bại (tài khoản cũ).** Giữ "bắt buộc" nhưng có một lối thoát duy nhất: "Không bật được? Dùng mật khẩu thay thế". Lối thoát được
   ghi `bio_optout` vào nhật ký. Không có lối thoát thì iCloud Keychain tắt hoặc trình duyệt lỗi sẽ khoá người dùng ngoài tài khoản.
6. **Thiếu mật khẩu sau sinh trắc.** Server không cấp phiên đầy đủ khi tài khoản chưa có mật khẩu. Trả về phiên "chờ" (`needPassword`),
   chỉ dùng được cho đặt mật khẩu và hoàn tất. Như vậy không thể vào trang chính bằng cách điều hướng thẳng.
7. **Chỉ kích hoạt tài khoản khi hoàn tất MỌI bước.** Cần dòng `users` tạm ngay sau OTP (để có mã người dùng cho khoá và mật khẩu) với
   `setup_complete = 0`: chưa có gói dữ liệu, chưa có tài khoản MQTT, chưa có gói mặc định, không hiện trong danh sách admin. Chỉ khi bước cuối
   (`/api/login/complete` hoặc `/complete-basic`) thành công, server mới **kích hoạt** (`identity.activateAccount`: tạo gói dữ liệu, MQTT, gói
   mặc định) rồi đặt `setup_complete = 1`. Kích hoạt lỗi thì vẫn chưa hoàn tất. Dòng tạm quá **24 giờ** bị xoá. Trong thời gian đó người dùng
   đăng nhập lại bằng OTP để làm tiếp.
8. **Không lộ tài khoản có tồn tại.** `/api/login/start` chỉ trả `hasPasskey` / `hasPassword` khi mã thiết bị gửi lên đã được tin cậy cho đúng
   số đó; mọi trường hợp khác trả `{ otpRequired: true }` giống nhau, kể cả số chưa đăng ký.
9. **Giới hạn thử:** mật khẩu khoá 15 phút sau 5 lần sai (dùng chung bộ đếm `pw_fail`); OTP có giới hạn gửi/đoán theo số điện thoại.
10. **Rủi ro còn lại:** passkey đồng bộ iCloud / Google nghĩa là ai chiếm được tài khoản đám mây dùng được khoá trên máy khác (nhưng máy chưa
    xác nhận OTP vẫn phải qua OTP). Telegram là điểm phụ thuộc duy nhất cho máy mới.

## 4. API

| Endpoint | Vai trò |
|---|---|
| `POST /api/login/start` `{phone}` | Kế hoạch: `{ otpRequired }` (+ `hasPasskey`, `hasPassword` nếu máy tin cậy) |
| `POST /api/login/request-otp`, `/verify-otp` | Bước 1. Trả phiên chờ (`pending`, `methods`) |
| `POST /api/webauthn/register/options` + `/verify` | Bước 2 khi chưa có khoá: gửi public key lên server |
| `POST /api/webauthn/auth/options` + `/verify` | Bước 2 khi đã có khoá, sau OTP |
| `POST /api/login/passkey/options` + `/verify` | Bước 2 trên máy tin cậy (không OTP). Thiếu mật khẩu trả phiên chờ `needPassword` |
| `POST /api/account/password` `{password}` | Bước 3: đặt mật khẩu (client đã yêu cầu nhập lại) |
| `POST /api/login/password` | Bước 3 trên máy tin cậy không có sinh trắc |
| `POST /api/login/complete` | OTP + sinh trắc. Cần phiên điều khiển |
| `POST /api/login/complete-basic` `{password}` | OTP + mật khẩu, hoặc sinh trắc + đặt mật khẩu. Trả phiên đầy đủ |

## 5. Kiểm thử cần có

- Từng dòng bảng quyết định: đạt và không đạt (OTP sai, sinh trắc huỷ / sai khoá, mật khẩu ngắn / lệch / sai, khoá sau 5 lần).
- Thứ tự bước: OTP trước sinh trắc trước mật khẩu; không bước nào cấp phiên đầy đủ khi chưa đủ điều kiện.
- Tài khoản mới: chỉ `setup_complete = 1` sau khi đặt mật khẩu hoặc đăng ký sinh trắc.
- Máy tin cậy ẩn ô OTP; xoá dữ liệu trang hiện lại OTP.
