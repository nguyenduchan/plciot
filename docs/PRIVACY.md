# Thông báo bảo vệ dữ liệu cá nhân (Privacy Notice)

**Phiên bản:** `2026-11-01` (đồng bộ `PRIVACY_NOTICE_VERSION` / `packages/security/src/privacy.js`)  
**Bản người dùng:** `webapp/privacy.html`

## Tóm tắt vận hành sản phẩm

| Hạng mục | Cách làm trên plciot |
|---|---|
| Thu thập tối thiểu | Không SĐT / email / Telegram OTP; đăng ký username; QR gắn sau login |
| Đồng ý | Bắt buộc `consent: true` khi `/api/register` và `/api/invites/redeem` |
| Lưu đồng ý | `users.privacy_consent_at`, `users.privacy_version` |
| Quyền xuất / xoá | `GET /api/account/data/export`, `POST /api/account/delete` (reauth) |
| DPO | Env `DPO_CONTACT`, `DPO_EMAIL` → `/api/auth/config` |
| Audit | `AUDIT_RETENTION_DAYS` (mặc định 365) |

## Cấu hình môi trường

```bash
PRIVACY_NOTICE_VERSION=2026-11-01
PRIVACY_URL=/privacy.html
DPO_CONTACT="Nguyễn Văn A — đầu mối BVDLCN"
DPO_EMAIL=dpo@example.vn
AUDIT_RETENTION_DAYS=365
```

Đổi `PRIVACY_NOTICE_VERSION` khi sửa nội dung trọng yếu → người dùng cũ có `privacy.needsConsent` và nên gọi `POST /api/account/privacy/consent`.

## Tài liệu nội bộ liên quan

- [BVDLCN-QUY-CHE.md](./BVDLCN-QUY-CHE.md) — quy chế nội bộ
- [DPIA-TEMPLATE.md](./DPIA-TEMPLATE.md) — đánh giá tác động
- [INCIDENT-RESPONSE.md](./INCIDENT-RESPONSE.md) — ứng phó sự cố
- [ENCRYPTION-AT-REST.md](./ENCRYPTION-AT-REST.md) — mã hoá dữ liệu nghỉ
