# Thiết kế bảo mật: đăng ký, đăng nhập và điều khiển

Tài liệu này giải thích **bảo vệ cái gì, chống ai, bằng cách nào và vì sao cách đó mạnh**. Chi tiết cấu hình/API nằm ở
[CONTROL-SECURITY.md](CONTROL-SECURITY.md); mã nguồn lõi nằm ở [`packages/security`](../packages/security/README.md).

---

## 1. Bài toán và kẻ tấn công

Hệ thống cho phép người ở xa **điều khiển máy móc thật** (bật/tắt đầu ra, đổi chế độ, đặt số lượng). Sai sót ở đây không chỉ
làm lộ dữ liệu mà có thể làm hỏng thiết bị hoặc gây nguy hiểm. Vì vậy ta phải trả lời hai câu hỏi **tách biệt**:

| Câu hỏi | Ví dụ | Mức rủi ro nếu sai |
|---|---|---|
| **Bạn là ai?** (nhận diện/đăng nhập) | Mở ứng dụng, xem số liệu | Lộ thông tin |
| **Bạn có thật sự muốn làm việc nguy hiểm này không?** (xác nhận hành động) | Gửi lệnh ghi xuống PLC | Hư hỏng/nguy hiểm vật lý |

Kẻ tấn công được tính đến:

| Kẻ tấn công | Cách làm điển hình |
|---|---|
| **Lừa đảo (phishing)** | Trang giả xin mã OTP/mật khẩu rồi dùng ngay |
| **Chiếm Telegram/SIM** | Đổi SIM, chiếm tài khoản Telegram để nhận OTP |
| **Chiếm điện thoại/phiên** | Lấy điện thoại đang mở khoá, lấy token trong trình duyệt (XSS) |
| **Dò mật khẩu/mã** | Thử hàng loạt OTP, mã Authenticator, mã khôi phục, mã ghép |
| **Phát lại (replay)** | Ghi lại một lần xác thực/lệnh hợp lệ rồi gửi lại |
| **Người trong cuộc** | Thành viên hoặc admin lạm quyền, PC nhà máy giả |
| **Kẻ ở giữa/mạng** | Đọc mật khẩu MQTT, giả địa chỉ IP, chen vào đường truyền |

---

## 2. Các nguyên lý xuyên suốt

Mọi quyết định thiết kế bên dưới là áp dụng các nguyên lý sau.

### 2.1 Không có bí mật để lộ hay để quên
Hệ thống **không dùng mật khẩu**. Điều mạnh nhất không phải là "mật khẩu khó đoán" mà là **không có mật khẩu để bị lừa nhập,
bị lộ qua rò rỉ dữ liệu, hoặc bị quên**. Thay vào đó dùng *khoá mật mã gắn với thiết bị* (Passkey) và *mã dùng một lần*.

### 2.2 Chứng minh bằng mật mã, không phải bằng "kể lại bí mật"
Với mật khẩu/OTP, người dùng *kể lại* bí mật cho server — ai nghe được là dùng được. Với Passkey, thiết bị **ký** một thử thách
mà server vừa tạo; **khoá riêng không bao giờ rời thiết bị**, chỉ chữ ký đi qua mạng, và chữ ký chỉ dùng được cho đúng một lần.

### 2.3 Gắn với tên miền (chống lừa đảo)
Chữ ký Passkey bao gồm *tên miền* nơi nó được tạo (`rpId`/`origin`). Trang giả `plc-gia.com` không thể xin chữ ký hợp lệ cho
`plc.thatcua.ban`: trình duyệt từ chối và server cũng kiểm tra lại. Người dùng không thể bị "lừa nhập" vì không có gì để nhập.

### 2.4 Chống phát lại: mọi thứ chỉ dùng được một lần, trong thời gian ngắn
Thử thách WebAuthn sống 2 phút và bị huỷ ngay khi dùng (kể cả khi sai); mã TOTP chỉ dùng được một lần (server nhớ bước thời gian
đã dùng); vé thêm thiết bị, mã ghép PC, mã khôi phục đều dùng một lần; yêu cầu của PC ký kèm thời gian + bộ nhớ chữ ký đã thấy.

### 2.5 Xác thực theo ngữ cảnh và theo độ nguy hiểm (step-up)
Xem số liệu chỉ cần đăng nhập. **Gửi lệnh** yêu cầu thêm một lần xác nhận bằng yếu tố mạnh, **gắn với mạng** hiện tại, và có thể
thêm **nút bấm vật lý** cho lệnh nguy hiểm nhất. Đăng nhập bị lộ ≠ điều khiển được.

### 2.6 Server là người quyết định cuối cùng (server-authoritative)
Điện thoại **không có quyền ghi** vào kênh lệnh MQTT. Mọi lệnh đi qua server, nơi kiểm tra yếu tố, quyền, danh sách thanh ghi
và khoảng giá trị. Nếu để điện thoại ghi thẳng MQTT, ai lấy được mật khẩu MQTT là điều khiển được mà không cần vân tay.

### 2.7 Đặc quyền tối thiểu
Mỗi người chỉ thấy/chạm đúng một nhà máy/thiết bị (ACL MQTT theo `site/device`); chỉ vài thanh ghi được ghi, mỗi thanh ghi
một khoảng giá trị; người xem không bao giờ có quyền ghi; chỉ chủ nhà máy mời thành viên và ghép PC.

### 2.7b Từ chối mặc định (fail closed)
Thiếu yếu tố → chặn. Hết hạn bật yếu tố → khoá điều khiển. Không chắc IP có từ proxy tin cậy → coi là IP trực tiếp. Lỗi khi
gửi cảnh báo không làm hỏng luồng nhưng cũng không làm yếu luồng.

### 2.8 Độ trễ có thể huỷ cho các thao tác "mất máy/mất tài khoản"
Khi không còn thiết bị cũ, việc cấp quyền cho thiết bị mới bị **chậm lại có chủ ý (24 giờ)**, kèm cảnh báo và liên kết huỷ một
chạm cho chủ thật. Kẻ tấn công phải thắng một cuộc đua mà chủ thật được báo trước.

### 2.9 Kênh độc lập
Một yếu tố chỉ đáng tin khi kẻ tấn công không thể chiếm được nó **cùng lúc** với yếu tố khác. Vì Telegram đăng nhập bằng SMS, nên
OTP Telegram **không bao giờ đủ để điều khiển** — nó chỉ là "ai đó có Telegram của bạn", chưa phải "bạn".

### 2.10 Chỉ lưu dạng băm/mã hoá, phòng khi lộ cơ sở dữ liệu
Token phiên điều khiển lưu băm SHA-256; bí mật TOTP mã hoá AES-256-GCM; mã khôi phục/mã ghép lưu HMAC; mật khẩu MQTT xoay vòng
khi đổi quyền. Lộ DB không cho phép dùng lại ngay.

### 2.11 Quan sát và cảnh báo
Mọi sự kiện nhạy cảm ghi `audit_log` (đăng nhập, mở khoá, lệnh bị từ chối, thêm thiết bị…). Chủ tài khoản được báo khi có thiết
bị lạ, yếu tố mới, yêu cầu thêm thiết bị, PC mới được ghép.

### 2.12 Phòng thủ nhiều lớp
Không lớp nào là duy nhất: nếu XSS lấy được token → còn CSP và phiên điều khiển gắn mạng; nếu có phiên → còn whitelist/khoảng giá
trị; nếu lệnh hợp lệ nhưng nguy hiểm → còn nút bấm vật lý và khoá liên động **trong PLC**.

---

## 3. Đăng ký

```
Người dùng ──(1) /start + chia sẻ SĐT──▶ Bot Telegram      (bot kiểm tra contact.user_id == from.id)
Người dùng ──(2) nhập SĐT─────────────▶ Server ──OTP 6 số──▶ Telegram của số đó
Người dùng ──(3) nhập OTP─────────────▶ Server: tạo tài khoản + vùng riêng s<SĐT>/plc01 + MQTT riêng
Người dùng ──(4) thiết bị đầu tiên────▶ Mời bật vân tay hoặc Authenticator ──▶ nhận 10 mã khôi phục
```

**Vì sao an toàn**
- **Chứng minh sở hữu số điện thoại:** bot chỉ chấp nhận số mà *chính tài khoản Telegram đó* chia sẻ; OTP gửi vào đúng Telegram ấy.
- **OTP:** 6 số, sống 5 phút, lưu băm; 5 lần sai khoá bản mã đó; **ngân sách theo số điện thoại bất kể IP**: tối đa 6 lần xin/giờ và
  10 lần sai/15 phút (chặn dò phân tán và spam Telegram nạn nhân); thêm giới hạn theo IP.
- **Cách ly dữ liệu từ đầu:** tài khoản mới nằm trong vùng riêng, có tài khoản MQTT riêng chỉ đọc `plc/<site>/<device>/*` của mình.
  Muốn vào nhà máy thật phải được chủ nhà máy mời, hoặc chứng minh đang đứng cạnh PLC.
- **Thiết bị đầu tiên được ghi nhớ** (`known_devices`). Đây là điểm neo cho quy tắc *chỉ thiết bị đầu tiên bật yếu tố ngay* (mục 5.1).
- **Mã khôi phục tự tạo** ngay khi bật yếu tố đầu tiên và buộc người dùng xác nhận đã lưu: để mất máy không phải nhờ ai.
- **Hạn 3 ngày** (`CONTROL_ENROLL_GRACE_DAYS`) để bật yếu tố; quá hạn → khoá điều khiển (vẫn xem được).

---

## 4. Đăng nhập

### 4.1 Passkey (cách chính)

Nguyên lý **thử thách–đáp ứng bằng khoá công khai**:

```
Server ──(1) challenge ngẫu nhiên (dùng 1 lần, 2 phút)──▶ Trình duyệt
Thiết bị: người dùng chạm vân tay/Face ID → mở khoá riêng đã lưu trong chip bảo mật
Thiết bị ký:  authenticatorData ‖ SHA-256(clientDataJSON)
              (clientDataJSON chứa: loại thao tác, challenge, ORIGIN)
Trình duyệt ──(2) chữ ký + authenticatorData + clientDataJSON──▶ Server
Server kiểm tra:  challenge khớp & chưa dùng · origin ∈ danh sách cho phép · hash(rpId) khớp
                  · cờ UP (có mặt) và UV (đã xác thực người dùng) đều bật
                  · chữ ký đúng với khoá công khai đã lưu · bộ đếm tăng
```

Vì sao mạnh:
- **Khoá riêng không rời thiết bị** và chỉ dùng được sau khi *sinh trắc/PIN máy* — server không có gì để lộ (chỉ giữ khoá công khai).
- **Chống phishing:** origin nằm trong dữ liệu được ký (mục 2.3).
- **Chống phát lại:** challenge dùng một lần; **bộ đếm** (`counter`) phải tăng — nếu khoá bị sao chép, hai bản sẽ lệch bộ đếm và bị phát hiện.
- **Bắt buộc User Verification** (`userVerification: required`): có thiết bị trong tay chưa đủ, phải qua vân tay/Face ID.
- **Passkey khám phá được** (`residentKey: required`): đăng nhập không cần gõ số điện thoại; `userHandle` trong chữ ký phải khớp chủ khoá.
- Attestation `none` (không thu thập thông tin phần cứng) → riêng tư; hỗ trợ ES256/RS256.

### 4.2 OTP Telegram (dự phòng và lần đầu)
Dùng khi chưa có passkey (người mới, máy mới). Giới hạn như mục 3. **Chỉ cho đăng nhập và xem**, không đủ để điều khiển
(mục 2.9) và không đủ để đăng ký yếu tố điều khiển trên máy không phải thiết bị đầu tiên (mục 5.1).

### 4.3 Phiên đăng nhập
- JWT **72 giờ, gia hạn trượt**: dùng hằng ngày thì không phải đăng nhập lại; khi quá nửa hạn, server cấp token mới qua header
  `X-Renewed-Token`. Bỏ 3 ngày mới phải đăng nhập lại — giảm cửa sổ bị lợi dụng nếu token bị lộ mà vẫn tiện dùng.
- **Thu hồi tức thì** bằng `token_version`: đổi số, khôi phục, gỡ thành viên, "Đăng xuất mọi máy" làm mọi token cũ vô hiệu.
- **Chống XSS lấy token:** CSP `script-src 'self'` (cấm script nội tuyến/nguồn lạ), `object-src 'none'`, `frame-ancestors 'none'`.
- **Cảnh báo thiết bị lạ:** webapp gửi một mã thiết bị ngẫu nhiên; thiết bị mới đăng nhập vào tài khoản đã có thiết bị khác → báo cho chủ.
- **Đăng xuất thật sự:** thu hồi phiên điều khiển ở server, xoá token cục bộ, và không tự đăng nhập lại bằng vân tay ngay sau đó.

### 4.4 Máy không có sinh trắc (PC)
Webapp kiểm tra có xác thực nền tảng không; nếu không → **không hiện nút vân tay**, chỉ còn OTP và Authenticator. Không có "đường tắt"
yếu hơn cho máy cũ: máy không dùng được vân tay/Authenticator thì tài khoản chỉ để **xem**.

---

## 5. Điều khiển

```
Điện thoại ──HTTPS──▶ POST /api/control/cmd  (JWT + X-Control-Token)
                         ① người dùng có quyền điều khiển? (role)         ← đặc quyền tối thiểu
                         ② còn trong hạn bật yếu tố?                       ← fail closed
                         ③ lệnh hợp lệ? thanh ghi ∈ whitelist, giá trị ∈ khoảng
                         ④ đã qua step-up? (Passkey 5 phút / TOTP 7 ngày, cùng mạng)
                         ⑤ lệnh nguy hiểm? → chờ nút bấm vật lý (nếu bật)
                         ⑥ server publish MQTT bằng tài khoản riêng "ctl"  ← điện thoại không có quyền này
Gateway/PLC ◀──MQTT plc/<site>/<device>/cmd──┘     khoá liên động an toàn nằm trong PLC
```

### 5.1 Yếu tố điều khiển và cách chúng được cấp
- **Passkey** (phiên 5 phút) hoặc **TOTP** (Authenticator, phiên 7 ngày). Không có yếu tố yếu hơn cho điều khiển.
- **TOTP:** mã 6 số theo thời gian (RFC 6238) tạo từ bí mật chung; cho lệch ±1 bước; server nhớ bước đã dùng nên **mã không dùng lại được**;
  sai 5 lần khoá 15 phút; bí mật lưu mã hoá AES-256-GCM.
- **Phiên điều khiển:** token ngẫu nhiên 256 bit (chỉ lưu băm), **gắn với mạng** (/24 IPv4, /64 IPv6): đổi mạng → phải xác nhận lại.
  Một token bị đánh cắp mà dùng từ mạng khác sẽ bị từ chối.
- **Chống chiếm Telegram tự bật yếu tố:** nếu tài khoản chưa có yếu tố nào, **chỉ thiết bị đầu tiên** được bật ngay. Kẻ chiếm Telegram
  đăng nhập từ máy lạ sẽ nhận `first_device_required` và phải qua email đã xác minh hoặc chờ 24 giờ (có cảnh báo + liên kết huỷ).
- **Thêm/đổi yếu tố về sau** cần phiên điều khiển đang mở: người nhặt được điện thoại không tự đăng ký vân tay của họ.

### 5.2 Kiểm tra lệnh (chống lạm dụng ngay cả khi đã xác thực)
| Thanh ghi | Ý nghĩa | Giá trị được ghi |
|---|---|---|
| D3 | chế độ tự động/thủ công | 0–1 |
| D4 | mặt nạ đầu ra Y0–Y7 | 0–255 |
| D6 | chạy/dừng băng tải | 0–1 |
| D7 | số lượng mục tiêu | 0–60000 |
| D9 | xoá số đếm | chỉ 1 |
Thanh ghi khác bị từ chối. Siết thêm bằng `CONTROL_REG_LIMITS`. Đây là lớp ở server; **khoá an toàn thật (E-stop, dừng khi đủ số lượng)
phải nằm trong chương trình PLC** để không phụ thuộc mạng hay phần mềm.

### 5.3 Nút bấm vật lý cho lệnh nguy hiểm
Với D4/D6 (tuỳ bật), server giữ lệnh và chỉ phát khi PLC báo có **cạnh tín hiệu mới** ở ngõ vào đã chọn trong ~30 giây. Kẻ ở xa dù
chiếm hết tài khoản cũng không thể bấm nút ở xưởng. (Modbus không xác thực nên đây là lớp bổ trợ, không thay khoá liên động PLC.)

### 5.4 MQTT: tách quyền đọc và ghi
Mỗi người dùng một tài khoản MQTT, ACL chỉ cho **đọc** topic của nhà máy mình (theo nhóm thông tin được cấp); **ghi `cmd` chỉ có
tài khoản `ctl` của server**, và chỉ trên kênh đã mã hoá. Mật khẩu MQTT của điện thoại bị lộ cũng không điều khiển được.

### 5.5 PC nhà máy (ký bằng khoá thiết bị)
Ghép cặp bằng **mã dùng một lần** (8 ký tự ≈ 40 bit, sống 10 phút) do chủ nhà máy tạo. PC tự sinh cặp khoá **ECDSA P-256**, khoá riêng
nằm trong DPAPI của Windows. Mỗi yêu cầu ký `thời-gian ‖ phương-thức ‖ đường-dẫn ‖ SHA-256(thân)`:
- sai khoá/sai nội dung → từ chối; sửa lệnh sau khi ký → phát hiện (băm thân);
- lệch giờ > 60 giây hoặc **chữ ký đã thấy** → từ chối (chống phát lại);
- đổi PC = ghép PC mới rồi thu hồi PC cũ, có hiệu lực ngay; chủ nhà máy được báo khi có PC mới.
Không dựa vào IP (mạng xưởng hay đổi IP công cộng); IP chỉ là lớp siết thêm tuỳ chọn.

---

## 6. Thêm thiết bị, khôi phục, đổi số (không cần admin, vẫn an toàn)

| Tình huống | Cách | Vì sao an toàn |
|---|---|---|
| Còn máy cũ | Máy cũ mở khoá rồi bấm **Cho phép** | Người duyệt đã qua vân tay/mã; chỉ máy cũ thấy yêu cầu |
| Mất máy cũ, còn mã khôi phục | Dùng 1 mã → **chờ 24 giờ** | Mã dùng một lần, tối đa 10 lần sai/24 giờ; chủ được báo + có nút huỷ |
| Có email đã xác minh | OTP email → **chờ 24 giờ** | Email là **kênh độc lập** với Telegram; email mới thêm phải "cách ly" 72 giờ |
| Chưa có yếu tố, máy không phải đầu tiên | **Chờ 24 giờ** | Cảnh báo cho chủ; nhưng xem giới hạn ở mục 8 |
Kết quả là một **vé đăng ký** sống 15 phút, dùng một lần, chỉ có tác dụng đăng ký yếu tố (không dùng để điều khiển hay làm thao tác nhạy cảm khác).
Đổi số điện thoại dùng cùng tư tưởng: OTP kênh cũ + OTP số mới (tức thì) hoặc mã khôi phục (chờ), luôn báo chủ cũ kèm liên kết huỷ.

---

## 7. Nhà máy và thành viên

- **Chủ nhà máy** mới được mời/gỡ thành viên và ghép/thu hồi PC; các thao tác này đòi xác nhận lại bằng vân tay/Authenticator.
- **Mời theo số điện thoại**, người được mời **tự chấp nhận** (vì việc đó chuyển họ sang nhà máy mới và đổi quyền MQTT).
- **Nhận thiết bị chưa có chủ:** phải chứng minh *đang đứng cạnh PLC* bằng cách bật-tắt một ngõ vào do server chọn trong 2 phút; site đã có người
  dùng thì không nhận được (tránh chiếm chỗ).
- **Gỡ thành viên:** về vùng riêng, đổi mật khẩu MQTT, thu hồi token và phiên điều khiển ngay.

---

## 8. Bảng tổng hợp: mối đe doạ → biện pháp

| Mối đe doạ | Biện pháp chính |
|---|---|
| Phishing xin OTP/mật khẩu | Không mật khẩu; Passkey gắn origin; điều khiển cần chữ ký, không cần "kể" bí mật |
| Chiếm Telegram/SIM | OTP Telegram không đủ để điều khiển; thiết bị đầu tiên; cảnh báo; chờ 24 giờ + huỷ |
| Mất/cướp điện thoại | Sinh trắc bắt buộc (UV); phiên điều khiển ngắn/gắn mạng; "Đăng xuất mọi máy"; thu hồi từ máy khác |
| XSS lấy token | CSP; phiên điều khiển gắn mạng; token đăng nhập ngắn hạn |
| Dò/đoán mã | Hạn mức theo IP, theo tài khoản và theo số điện thoại; khoá sau nhiều lần sai |
| Phát lại | Challenge/vé/mã một lần; TOTP nhớ bước; chữ ký PC có thời gian + bộ nhớ chữ ký; bộ đếm passkey |
| Thành viên/admin lạm quyền | Đặc quyền tối thiểu; thao tác nhạy cảm đòi xác nhận lại kể cả admin; audit |
| PC giả | Khoá thiết bị ECDSA + mã ghép một lần; thu hồi tức thì |
| Lộ cơ sở dữ liệu | Băm/mã hoá mọi bí mật; mật khẩu MQTT xoay vòng |
| Giả IP bằng header | Chỉ tin `X-Forwarded-For`/`CF-Connecting-IP` từ proxy tin cậy |
| Lệnh nguy hiểm/giá trị bậy | Whitelist + khoảng giá trị; nút vật lý; khoá liên động trong PLC |

---

## 9. Giới hạn đã biết và chưa kiểm chứng

Cần trung thực về những gì **chưa** hoàn hảo:
- **Người chưa bật yếu tố nào** chỉ được bảo vệ bằng tài khoản Telegram/SIM của họ. Ai đăng nhập *trước chủ thật* trên một tài khoản chưa từng ghi nhận thiết bị sẽ trở thành "thiết bị đầu tiên". Hạn 3 ngày và việc bắt buộc bật yếu tố giảm thời gian bị lộ này.
- Đường "chờ 24 giờ" cho tài khoản chưa có yếu tố chỉ thật sự an toàn nếu chủ còn nhận được cảnh báo; **nên xác minh một email độc lập**.
- JWT và token điều khiển nằm trong `localStorage` (không phải cookie HttpOnly): CSP làm XSS khó hơn nhưng không loại bỏ hoàn toàn.
- WebAuthn tự viết (không dùng thư viện); đã thử bằng bộ xác thực phần mềm, **chưa thử trên iPhone/Android thật**; nhánh RS256 chưa có test.
- Nút bấm vật lý **mặc định tắt**; Modbus không xác thực nên chỉ là lớp bổ trợ. Khoá liên động trong PLC phải được kiểm tra riêng.
- Kênh MQTT không mã hoá (1883/9001) chỉ-xem vẫn tồn tại; mật khẩu MQTT của người dùng đi dạng rõ trên kênh đó.
- Giới hạn tần suất lưu trong bộ nhớ một tiến trình (mất khi khởi động lại, không dùng được nếu chạy nhiều tiến trình).
- Một `APP_JWT_SECRET` dẫn xuất nhiều khoá (TOTP, mã khôi phục, mã ghép, token huỷ); lộ nó ảnh hưởng nhiều thứ. Đổi tiền tố/secret làm mất mã khôi phục và TOTP đã lưu.

---

## 10. Kiểm thử và tham chiếu mã

| Nội dung | Nơi xem |
|---|---|
| Passkey, TOTP, phiên điều khiển, thêm thiết bị, ghép PC, CSP, giới hạn tần suất | `packages/security/src/*` |
| Test lõi bằng app đồ chơi (không PLC) | `packages/security/test/smoke-security.js` |
| Luật lệnh PLC, route lệnh, nút vật lý | `cloud/app/src/plcCommands.js`, `plcControlRoutes.js` |
| Nhà máy, mời thành viên, nhận thiết bị | `cloud/app/src/sites.js`, `siteRoutes.js` |
| Client trình duyệt dùng chung | `packages/security/client/` (bản sao `webapp/security/`) |
| PC nhà máy phía C# | `scada/src/Plciot.Scada.Services/StationClient.cs` |
| Test tích hợp | `cd cloud/app && npm test`; `dotnet test scada/tests/Plciot.Scada.Tests` |

Đã thử thủ công trọn vòng (đăng ký → bật yếu tố → điều khiển → đăng nhập lại → thêm máy mới → mời thành viên → ghép PC) với server thật,
broker MQTT thật, bot Telegram giả, cả giả lập PC không sinh trắc lẫn điện thoại có vân tay; các lỗi tìm được đã sửa.
