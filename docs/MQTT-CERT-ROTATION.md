# Chống giả mạo: chứng chỉ, chữ ký cập nhật, HTTPS

Tóm tắt các lớp chống kẻ giữa đường (MITM) giữa gateway/board/trình duyệt và VPS `plc.dieukhientudong.net`.

| Đường | Kiểm gì | Ở đâu |
|---|---|---|
| Trình duyệt → web | Chứng chỉ Cloudflare (CA công khai). App: http → 301 https, POST qua http → 403, HSTS 1 năm | `packages/security/src/headers.js` (`httpsOnly`) |
| GatewayApp → API (HTTPS) | Kho CA của Windows (Windows Update tự cập nhật) | HttpClient mặc định |
| Board → API / tải firmware (HTTPS) | Bộ CA gốc Mozilla gắn trong firmware (`esp_crt_bundle_attach`) — có ISRG/Let's Encrypt, Google Trust Services, SSL.com mà Cloudflare dùng | `gateway-mcu/src/cloud.cpp`, `ota.cpp` |
| Gateway/board → MQTTS (VPS:48263) | Ghim SHA-256 chứng chỉ tự ký, **danh sách** (đang dùng + dự phòng) | `CloudPins.cs`, `cloud.cpp` `pinMatches` |
| Gói cập nhật GatewayApp | Chữ ký ECDSA P-256, khoá công khai gắn cứng trong app; chỉ cập nhật qua https (http chỉ cho server trong LAN) | `tools/GatewayApp/UpdateSignature.cs` |
| Firmware board | Chữ ký ECDSA + chủ trạm duyệt | `docs/OTA-APPROVAL.md` |
| GatewayApp → board trong LAN / hotspot | **Mô hình: tin mạng LAN và người cầm board, chỉ chống tấn công từ internet.** Board lạ trong LAN được ghim mã phần cứng ngay lần đầu (không hỏi, board không dán nhãn). Ghép PC mới: nhấn BOOT là dùng ngay (không chờ PC cũ). Board **đang có chủ** mà PC lạ ghép bằng BOOT (bán / chuyển board) → GatewayApp hỏi, đồng ý thì board **xoá dữ liệu chủ cũ** (cấu hình, kết nối cloud, chương trình logic, nhật ký, dữ liệu chờ gửi, PC quản trị cũ; giữ mạng + khoá danh tính) và khởi động lại — không cần gì từ PC cũ; chủ trên server chuyển theo người cầm máy (`gatewayTransfer.js`). Chủ cũ muốn thêm PC mà không xoá: khôi phục bản sao lưu `.gwbackup` (có khoá PC + danh sách board) hoặc đăng nhập webapp. Test: `node cloud/app/scripts/sim-owner-wipe-e2e.js` | `RemoteClient.ConnectMcuAsync`, `gateway-mcu/src/api.cpp` (`hLogin`), `store.cpp` (`storeWipeOwner`) |

Không cần "cài ca-certificates" thêm: board và Windows đã có kho CA. **Không thu hẹp bộ CA của board** — Cloudflare đổi CA thì board mất đường HTTPS.

## Ký gói cập nhật GatewayApp

- Khoá riêng: `%USERPROFILE%\.plciot\gw-sign.pem` (hoặc env `GW_SIGN_KEY`), **ngoài repo**, khác khoá firmware. Sao lưu ra USB.
- `publish-gateway.ps1` (gọi từ `sync-vps.ps1`) tự ký → `manifest.json` có `sig`; thiếu khoá thì dừng (dùng `-SkipGateway` trên máy không có khoá, hoặc chép khoá qua USB).
- Thông điệp ký: `gw1|<sha256 zip>|<version>|<apiLevel>`. Server chỉ chuyển tiếp `sig`, không giữ khoá → chiếm VPS/Cloudflare cũng không phát được exe lạ.
- Đổi khoá: thêm khoá công khai mới vào `UpdateSignature.TrustedKeys`, phát hành bằng khoá CŨ, đợi mọi gateway lên bản đó (bảng `gateway_clients`), rồi mới ký bằng khoá mới và bỏ khoá cũ.
- Bản GatewayApp cũ (trước khi có chữ ký) vẫn cập nhật được lên bản mới; từ bản mới trở đi gói không ký bị từ chối.

## Ghim nhiều chứng chỉ MQTTS

`MQTT_PUBLIC_PIN_SHA256` trong `cloud/.env` = `"<đang phục vụ>,<dự phòng>"`. Cái đầu là chứng chỉ HAProxy đang phục vụ (gateway cũ chỉ đọc `pinSha256` = cái đầu); kit có thêm `pins` = cả danh sách.
Gateway PC và board nhận danh sách lúc đăng ký **và mỗi lần đồng bộ cấu hình** (`/api/v1/gateway/config`, chỉ khi qua https), nên đổi chứng chỉ không phải đăng ký lại.

HAProxy (`cloud/config/haproxy-entrypoint.sh`) tự tạo chứng chỉ dự phòng `/persist/mqtt-next.pem` (10 năm, chưa phục vụ) và in dòng `MQTT_PUBLIC_PIN_SHA256=<đang dùng>,<dự phòng>` trong log lúc khởi động:

```bash
docker logs plciot-haproxy 2>&1 | grep MQTT_PUBLIC_PIN_SHA256
```

### Đổi sang chứng chỉ dự phòng (hết hạn 16/02/2029, hoặc khoá lộ)

1. Kiểm tra mọi gateway đã nhận danh sách mới: chúng đồng bộ cấu hình mỗi 5 phút; gateway lâu không online phải đợi. Gateway quá cũ (chưa có `pins`) cần cập nhật trước.
2. Trên VPS:
   ```bash
   docker exec plciot-haproxy sh -c 'cp /persist/mqtt-next.pem /persist/mqtt.pem && rm /persist/mqtt-next.pem'
   docker restart plciot-haproxy          # phục vụ bản dự phòng, tự tạo bản dự phòng MỚI
   docker logs plciot-haproxy 2>&1 | grep MQTT_PUBLIC_PIN_SHA256
   ```
3. Đặt dòng in ra vào `cloud/.env` (`<mới đang dùng>,<dự phòng mới>`), khởi động lại app. Gateway nhận danh sách mới ở lần đồng bộ tới.

Khoá chứng chỉ bị lộ: làm như trên nhưng coi cả hai cũ là hỏng — tạo bản dự phòng mới trước (`rm /persist/mqtt-next.pem` + restart), đợi gateway nhận, rồi mới đổi.

## Cloudflare (bảng điều khiển, chỉnh tay)

- SSL/TLS → Edge Certificates: **Always Use HTTPS** bật, **Minimum TLS Version** = 1.2, **HSTS** bật (app cũng tự gửi HSTS).
- DNS: bản ghi CAA cho `dieukhientudong.net`: `0 issue "letsencrypt.org"`, `0 issue "pki.goog"`, `0 issue "ssl.com"` (các CA Cloudflare dùng cho chứng chỉ miễn phí).
