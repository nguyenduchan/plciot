# GatewayProvisioner — tool nạp gateway (PC sản xuất)

Nhập **mã yêu cầu** hiển thị trên gateway → tool xin VPS cấp QR + khoá + mã kích hoạt → ghi vào gateway qua LAN → gateway tự kiểm mã và xác nhận.

## Chuẩn bị (một lần)
1. Admin vào trang quản trị → **Token cho tool nạp gateway** → tạo token (chỉ hiện một lần).
2. Chạy tool, dán token. Tick "Nhớ token" để lưu (mã hoá DPAPI theo tài khoản Windows).

```powershell
cd tools\GatewayProvisioner
dotnet build -c Release          # bin\Release\net8.0-windows\GatewayProvisioner.exe
```

## Dùng
1. Gateway bật, cùng mạng LAN, hiển thị mã yêu cầu (ví dụ `GW7K-2M9X-A4QP-8RTC`).
2. Nhập địa chỉ gateway, site, device, bấm **Lấy mã từ gateway** (hoặc gõ tay mã yêu cầu).
3. Bấm **Nạp gateway**. Thành công khi gateway trả `ok:true`.

Chạy không giao diện (script/test):

```powershell
$env:GP_TOKEN = "fac_..."
GatewayProvisioner.exe --vps https://plc.dieukhientudong.net --gateway 192.168.1.50 --site demo_home --device gw01 --request GW7K2M9XA4QP8RTC [--profile iot-hub] [--days 365]
```

## Giao thức HTTP gateway cần cài (firmware)
| | |
|---|---|
| `GET /provision/request` | → `{"request":"<ID máy><NONCE 8 ký tự>"}`. NONCE sinh ngẫu nhiên, giữ tới khi nạp xong. |
| `POST /provision` | body `{site, device, qr, key, code, exp}`. Gateway tự kiểm `code` (bên dưới); đúng thì lưu `site, device, qr, key` vào vùng bảo vệ và trả `{"ok":true}`; sai trả `{"ok":false,"error":"activation_typo"\|"activation_wrong_device"\|"activation_expired"}`. |

## Thuật toán kiểm mã (gateway)
- Bảng Crockford base32: `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Chuẩn hoá mã gõ: chữ hoa, bỏ khoảng trắng và `-`, `O→0`, `I,L→1`.
- Mã = 20 ký tự: `EXP`(3) + `MAC`(16) + `CHECK`(1).
- `CHECK` = `B32[ (Σ giá_trị(ký_tự_i) × (i+1)) mod 32 ]` tính trên 19 ký tự đầu. Sai → `activation_typo`.
- `MAC` = base32 của **10 byte đầu** của `HMAC-SHA256(key, "act2|<ID>|<NONCE>|<EXP>")` (`key` = 32 byte từ hex). Sai → `activation_wrong_device`.
- `EXP` = số ngày kể từ 2020-01-01 (3 ký tự base32, 15 bit); `0` = không hết hạn. Nếu hôm nay (UTC) lớn hơn → `activation_expired` (cần đồng hồ đáng tin).
- Khuyến nghị: khoá nhập sau 5 lần sai; chỉ nhận mã khớp NONCE đang hiển thị; xoá NONCE sau khi nạp thành công.

## Bảo mật
- Khoá `key` đi qua HTTP LAN không mã hoá: chỉ nạp trong mạng xưởng cách ly. Bước nâng cấp: trao đổi khoá ECDH để khoá không bao giờ truyền đi.
- Token chỉ cho phép gọi `/api/v1/factory/provision`, không có quyền admin. Thu hồi trên trang quản trị là hết hiệu lực ngay.
- Tool không bao giờ thu hồi thiết bị đang có người dùng; muốn nạp lại phải để admin thu hồi.

## Loại gateway × có/không internet

| Chọn | Tool làm gì | Cần nhập |
|---|---|---|
| MCU, có internet | Nạp QR + MQTT + topic vào MCU (COM/TCP/HTTP). Không kích hoạt. | — |
| MCU, không internet | Như trên + mã kích hoạt theo thử thách. | Mã yêu cầu (bấm "Lấy mã từ gateway") |
| PC, có internet | Ghi kit ra file; gateway PC tự gắn máy khi enroll. | Kết nối `file:C:\kit\gw01.json` |
| PC, không internet | Ghi kit + file giấy phép theo ID máy. | Kết nối `file:...` + **ID máy** từ màn hình kích hoạt của PC khách |
| Mua sẵn | Nạp QR + topic. Không kích hoạt. (Không hỗ trợ "không internet".) | — |

Headless: `--kind mcu|pc|generic --offline true|false` (bỏ `--kind` = cách cũ theo `--activate`).
File giấy phép chứa khoá riêng của đúng một máy — chỉ gửi cho khách đó, không đăng công khai.
