# Kích hoạt subscribe từ điện thoại — chỉ tài khoản của bạn

Có thể **accept/grant gói từ điện thoại**: mở app (HTTPS) → đăng nhập Passkey → **Console dịch vụ IoT** → tab **Gói / Subscribe**.

## Chỉ chấp nhận account của bạn

Trong `.env` VPS (một SĐT của bạn):

```env
ADMIN_PHONES=0901234567
ADMIN_DASHBOARD_PHONES=0901234567
```

- `ADMIN_PHONES` — bootstrap role admin khi khởi động  
- `ADMIN_DASHBOARD_PHONES` — **chỉ các SĐT này** gọi được `/api/admin*`, Console, grant gói  
  (không set thì dùng lại `ADMIN_PHONES`)

User khác dù bị gán nhầm `role=admin` trong DB cũng **không** vào được dashboard nếu không nằm trong list. Không thể tạo/nâng admin ngoài list (`admin_not_allowlisted`).

## Phân biệt PC nhà — chống giả mạo

Trình duyệt **không** tự biết “PC nhà”. Đánh dấu = **bạn** xác nhận trên đúng máy đó.

**Không đủ** để giả: copy UUID / `X-Device-Id` sang máy khác.

**Cần đồng thời:**

1. Đăng nhập đúng SĐT trong `ADMIN_DASHBOARD_PHONES`  
2. **Passkey** (reauth) khi đánh dấu và khi grant  
3. **Khoá ECDSA trong IndexedDB** của đúng trình duyệt — lúc đánh dấu server lưu *public key*; mỗi lần grant máy phải **ký lại** (`deviceProof`). Không có private key trên máy kia → không giả được.

Cách làm:

1. Mở Console **trên đúng PC nhà** → **Tổng quan**  
2. **Đánh dấu PC này là máy nhà** → Passkey  
3. Grant gói từ máy đó (hoặc điện thoại của bạn nếu cũng đánh dấu / dùng CF Access)

Gỡ: nút **Gỡ**. Đã đánh dấu cũ (chưa có khoá) → đánh dấu lại. `ADMIN_HOME_PC_MAX=3`.

## Đồng bộ GitHub / cập nhật server (Console → Monitor)

Nút **Đồng bộ webapp** / **Cập nhật server** kéo code mới từ GitHub rồi đẩy bundle cho mọi user.

1. Trên VPS, repo đã `git clone` và `origin` trỏ GitHub (SSH deploy key hoặc HTTPS token nếu private).
2. Trong `cloud/.env` — **dùng đường dẫn tuyệt đối** (cùng path trong container và trên host):

```env
DEPLOY_ENABLED=true
DEPLOY_GIT_BRANCH=main
DEPLOY_REPO_HOST=/opt/plciot
DEPLOY_REPO_DIR=/opt/plciot
DEPLOY_COMPOSE_FILE=/opt/plciot/cloud/docker-compose.yml
```

3. Rebuild app một lần (`git` + docker CLI trong image):  
   `cd /opt/plciot/cloud && docker compose up -d --build app`
4. Console → **Monitor** → **Đồng bộ webapp** (UI + bundle) hoặc **Cập nhật server** (pull + rebuild `app`).

Sau đó user **refresh** / mở lại app: `boot.js` thấy `version` mới → tải lại source (không cần đăng nhập lại nếu session còn). Trang login/console cũng `Cache-Control: no-cache`.

## Monitor & kill switch (Console → tab Monitor)

Theo dõi nhanh như SaaS: uptime/RAM, deny MQTT, fail đăng nhập/control, top IP, nhật ký.

**Bật/tắt thủ công** (Passkey + PC nhà): đăng ký, đăng nhập, ingest MQTT, điều khiển từ xa, Partner API.
Tắt đăng nhập khoá cả bạn — bật lại bằng session còn sống hoặc SSH (`DELETE FROM ops_flags` / `.env`).

## Bảo mật tốt nhất

| # | Biện pháp | Việc làm |
|---|---|---|
| 1 | **Chỉ SĐT của bạn** | `ADMIN_DASHBOARD_PHONES=…` |
| 2 | **Đánh dấu PC nhà** | Nút trên Console (ở trên) |
| 3 | **Passkey** | Mọi grant / đánh dấu đều reauth |
| 4 | **Cloudflare Access** | Chỉ email bạn cho `/console.html`, `/api/admin*` |
| 5 | **`REGISTRATION_OPEN=false`** | Không tự đăng ký công khai |
| 6 | **`SUBSCRIBE_AUTO_GRANT=false`** | Không tự nhận gói |
| 7 | (Tuỳ chọn) `ADMIN_OPS_ALLOW_CIDRS` | Thêm IP nhà cố định |
| 8 | **Tab Monitor** | Kill switch khi nghi tấn công |

**Không nên:** chỉ dựa vào “biết URL console”; không chia sẻ máy đã mở khoá Passkey.

Ví dụ gọn:

```env
ADMIN_PHONES=0901234567
ADMIN_DASHBOARD_PHONES=0901234567
SUBSCRIBE_REQUIRE_ACTIVATION=true
SUBSCRIBE_AUTO_GRANT=false
REGISTRATION_OPEN=false
CF_ACCESS_TRUST=true
CF_ACCESS_ALLOW_EMAILS=ban@example.com
```

## Cách grant trên điện thoại

1. Safari/Chrome → `https://plc.…/login.html` → Passkey  
2. Cài đặt → **Console dịch vụ IoT** (chỉ hiện với account allow-list)  
3. Tab **Gói / Subscribe** → chọn user → `pro` / `monitor` → **Gán gói** → xác nhận vân tay  

Hoặc SSH (an toàn hơn khi ngồi máy tính): `plan.js grant …`.

## Luồng

```
User đăng ký  →  chờ kích hoạt (AUTO_GRANT=false)
Bạn (điện thoại, đúng SĐT)  →  Console + Passkey (+ CF Access)
        →  grant monitor|pro|factory
```
