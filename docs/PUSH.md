# Cảnh báo nguy hiểm trên điện thoại (Web Push)

Server **không lưu số điện thoại / email**. Mỗi thiết bị chỉ để lại `endpoint + p256dh + auth` (ẩn danh) gắn với `user_id` trong bảng `push_subs`. Không lưu IP / user-agent. Xoá tài khoản → xoá luôn đăng ký push.

- Khoá VAPID: env `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, hoặc tự sinh một lần ở `DATA_DIR/vapid.json`. Subject là URL https của app (không dùng email).
- API (cần đăng nhập): `GET /api/push/key`, `GET /api/push/status`, `POST /api/push/subscribe {subscription}`, `POST /api/push/unsubscribe {endpoint}`, `POST /api/push/test`.
- Chỉ nhận endpoint của push service đã biết (FCM, Mozilla, Apple, Windows); thêm bằng `PUSH_ENDPOINT_HOSTS=host1,host2`.
- Nguồn cảnh báo (`pushAlerts.js`, gọi từ `mqttIngest`): (1) `d.<child>.<field>` vượt `low`/`high` mà gateway khai trong config; (2) status `offline` / `plc_fault` / `fault`. Chỉ báo khi chuyển trạng thái, chờ `PUSH_COOLDOWN_SEC` (mặc định 300) giữa hai lần báo cùng mức.
- Webapp: Cài đặt → "Cảnh báo nguy hiểm trên điện thoại" (`webapp/push.js`, `sw.js`). iPhone cần "Thêm vào Màn hình chính".
- Test: `node cloud/app/scripts/smoke-push.js` (offline); `node cloud/app/scripts/e2e-push-mozilla.js --api <url> --token <jwt> --wait 60` (đóng vai Firefox thật qua push.services.mozilla.com).
