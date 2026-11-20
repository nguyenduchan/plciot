# Mất trộm gateway: báo mất → khoá tạm → admin duyệt

Khoá theo **mã phần cứng** (`hw`, 20 ký tự = băm khoá công khai của gateway; `cloud/app/src/hwBlock.js`). Gateway PC (GatewayApp) và board Waveshare dùng chung cơ chế.

## Luồng

1. **Chủ báo mất** (webapp → Cài đặt → *Báo mất gateway*, hoặc `POST /api/gateway/lost { gw:"site/device", reason }`).
   Cần đăng nhập **và yếu tố thứ hai** (TOTP / Face ID, giống lệnh điều khiển); chỉ gateway của chính tài khoản; tối đa `HW_REPORTS_PER_DAY` (3) báo cáo/ngày/tài khoản.
2. **Khoá tạm ngay**: server ghi `blocked_hw` + báo cáo `pending`, gửi `{sys:"lock"}` (ký) tới gateway đang nối. Gateway offline thì khoá khi lên mạng (hỏi `/gateway/config` → `device_blocked`).
3. **Admin xem** (`admin.html` → mục *Khoá thiết bị mất trộm* → *Chủ gateway báo mất*; `GET /api/admin/hw-reports`):
   - **Duyệt** (`POST /api/admin/hw-reports/:id/approve`): giữ khoá, ghi tên admin; chỉ admin mở lại được (`DELETE /api/admin/hw-blocks/:hw`) → báo cáo thành `released`.
   - **Từ chối** (`.../reject`): báo nhầm / đã tìm thấy → mở khoá (`{sys:"unlock"}`).
4. **Chủ tìm lại máy** khi báo cáo còn `pending`: `POST /api/gateway/lost/:id/cancel` (cần step-up) → mở khoá. Báo cáo đã duyệt thì chủ không tự mở được.

Trạng thái báo cáo (`hw_reports.status`): `pending` · `approved` · `rejected` · `cancelled` · `released`. `GET /api/gateway/lost` trả báo cáo của chính user.

## Khi đang khoá

- **Server**: từ chối đăng ký / enroll / hỏi config / lấy lại QR / chuyển PC của hw đó (`device_blocked`); lệnh điều khiển tới gateway đó trả `423 gateway_locked`.
- **Board Waveshare**: dừng đọc PLC, không gửi dữ liệu, ack lệnh `device_locked`, từ chối mọi đăng nhập LAN (kể cả PC đã ghép) và nhấn BOOT không mở ghép PC; LED đỏ nhấp nháy; **giữ qua mất điện / reset BOOT** (NVS).
- Mở khoá: board nhận `{sys:"unlock"}`; nếu đang tắt thì tự mở khi lên mạng và hỏi config thấy hết bị chặn.

Bảng `hw_reports` chỉ THÊM (DB_SCHEMA_VERSION 4). Test: `node cloud/app/scripts/smoke-hwreport.js` (+ `smoke-hwblock.js`).
