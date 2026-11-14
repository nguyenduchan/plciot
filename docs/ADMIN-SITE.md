# Trang admin riêng (adminplc.dieukhientudong.net)

Trang admin tách khỏi web app: tên miền riêng, đăng nhập riêng, không nằm trong `plc.dieukhientudong.net`.

- **Cấu hình**: `ADMIN_HOST=<tên miền>` trong `cloud/.env` (+ `.\cloud\scripts\sync-vps.ps1 -Build`).
  Khi đặt, tên miền app trả 404 cho `admin.html`, `console.html`, `/api/admin/*`; tên miền admin chỉ phục vụ trang admin + API admin. Đường hầm SSH (`admin-tunnel.ps1`) vẫn dùng được.
- **Ai vào được**: chỉ tài khoản trong `ADMIN_DASHBOARD_USERS` (hiện: `nguyenduchan`), và từ Internet phải nằm trong `ADMIN_INTERNET_USERS`.
- **Đăng nhập** (`/admin-login.html`): tên đăng nhập + mật khẩu + mã Authenticator. Lần đầu chưa có Authenticator thì bắt buộc đăng ký ngay (`ADMIN_REQUIRE_TOTP=false` để bỏ). Sai 5 lần → khoá 15 phút. Phiên 8 giờ (`ADMIN_SESSION_HOURS`), token của app thường không dùng được ở đây.
- **Cài đặt** (`/admin-settings.html`): đổi mật khẩu, đổi Authenticator, xem/ngắt phiên, nhật ký đăng nhập admin, trạng thái cờ bảo mật.
- Mất điện thoại Authenticator: vào bằng đường hầm SSH (`ADMIN_SSH_LOGIN=true`) rồi đổi trong Cài đặt, hoặc xoá `totp_*` của user trong DB.

## Cloudflare
Zero Trust → Networks → Tunnels → tunnel của dự án → **Published application routes** → thêm hostname `adminplc.dieukhientudong.net` → HTTP `app:3080`.
Lưu ý: Universal SSL miễn phí chỉ phủ tên một cấp (`*.dieukhientudong.net`), nên dùng `adminplc.dieukhientudong.net` (không phải `admin.plc.…`, cần Advanced Certificate Manager trả phí).
