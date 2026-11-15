# Giải pháp (kiểu giao diện webapp + gateway)

Một hệ thống, nhiều giao diện. **Chỉ khác giao diện**: đăng nhập, cài đặt, quét QR, chat, gói, MQTT, ghép cặp đều dùng chung mã của bản cơ bản.

## Cấu trúc: mỗi giải pháp là một thư mục độc lập

```
solutions/<id>/
  solution.json      { "title", "themeColor", "mode": "overlay" | "full", "inject": { "css": [], "js": [] } }
  webapp/            file giao diện của giải pháp
  gateway/           solution.json + *.cs (giao diện gateway C#)
```

Có thể phát triển ở repo khác rồi chép thư mục vào `solutions/` — server tự nhận (không sửa code server).

## Webapp

- `overlay` (mặc định): `webapp/` của giải pháp chồng lên `webapp/` cơ bản (file trùng tên thì giải pháp thắng); `inject` chèn CSS/JS vào `index.html`. Sửa mã dùng chung → mọi giải pháp nhận bản mới.
- `full`: bundle chỉ gồm file của giải pháp (webapp độc lập hoàn toàn; tự lo đăng nhập/boot như bản cơ bản).
- Mapping user ↔ giải pháp: cột `users.solution` (admin đặt trong trang Người dùng, ô chọn "giải pháp"; đổi là bundle thay ngay). Trống → `DEFAULT_SOLUTION` (env, mặc định `basic`). Id lạ/thư mục mất → tự về `basic`.
- Triển khai: `.\cloud\scripts\sync-vps.ps1 -Build` (đã gồm `solutions/`; compose mount `../solutions:/app/solutions`).
- Code: `cloud/app/src/solutions.js`. Test: `cloud/app/scripts/smoke-solutions.js`.

## Gateway (C# GatewayApp)

```powershell
dotnet build tools/GatewayApp -c Release                      # bản cơ bản
dotnet build tools/GatewayApp -c Release -p:Solution=solar    # bản solar (biên dịch solutions/solar/gateway/*.cs vào)
```

Giải pháp đăng ký qua `[ModuleInitializer]` vào `Ui/SolutionHost.cs` (đổi bảng màu `Theme`, thêm trang). Địa chỉ server: file `server.json` (ẩn) cạnh file chạy; ghép cặp bằng QR như bản cơ bản.

## Giải pháp solar

Field gateway nên gửi (`d.<thiết bị>.<field>`, kW hoặc W): `pv_kw`, `load_kw`, `grid_kw` (+mua/−bán), `batt_kw` (+sạc/−xả), `batt_soc`, `e_today`, `e_total`. Loại thiết bị trên server: `inverter`, `battery`, `grid-meter`.
Lịch sử sản lượng trong webapp solar được ghi trên thiết bị người dùng khi app mở (chưa lấy từ DB server).

## Quản lý trong admin (không cần sửa code server)

- Thư mục chuẩn đồng bộ: PC `solutions/` ↔ VPS `/root/plciot/solutions/` (`.\cloud\scripts\sync-solutions.ps1` chỉ chép thư mục này, không build/restart). Xem `solutions/README.md`, mẫu `solutions/_template/`.
- **Mục trong ô chọn tự động:** thư mục mới chép lên server tự có mục (mã = tên thư mục). Admin → tab **Giải pháp** chỉ để đổi tên hiển thị, ẩn/hiện, trỏ mục sang thư mục khác hoặc thêm mục tên khác cho cùng một thư mục. Sổ lưu ở `<DATA_DIR>/solutions.json`. Xoá mục mang tên thư mục còn trên đĩa chỉ ẩn (không tự hiện lại).
- Gán người dùng: admin → **Người dùng** → ô “giải pháp” (đổi là bundle thay ngay).

## Giải pháp ngành (sinh từ `tools/solution-kit/`)

Một engine giao diện dùng chung (`industry.js` + `industry.css`) đọc `spec.js` của từng giải pháp (chỉ số, ngưỡng, khối giao diện, dữ liệu mẫu). Bảng màu riêng ở `theme.css`. Sinh lại: `python tools/solution-kit/gen.py [id…]` (ghi `solutions/<id>/` độc lập, mỗi thư mục có bản copy engine). Xem thử không cần server: `python tools/solution-kit/preview.py <thư_mục>` rồi `python -m http.server`.

| Nhóm | Giải pháp |
|---|---|
| Hạ tầng, tiện ích | `water` cấp nước/trạm bơm · `wwtp` xử lý nước thải · `energy` điện 3 pha · `hvac` tòa nhà · `elevator` thang máy · `lighting` chiếu sáng · `env` quan trắc môi trường · `weather` khí tượng thủy văn |
| Công nghiệp, xưởng | `factory` OEE · `andon` bảng Andon · `workshop` xưởng cơ khí · `process` P&ID pha chế · `boiler` lò hơi · `compressor` khí nén · `dryer` lò sấy · `tank` bồn xăng dầu/hóa chất · `facility` mặt bằng nhà máy · `schedule` lịch vận hành |
| Nông nghiệp, chuỗi lạnh | `agri` nhà kính · `aqua` thủy sản · `coldchain` kho lạnh |
| Trạm độc lập, di động | `bts` viễn thông · `pumpstn` trạm bơm pin mặt trời · `generator` máy phát/ATS · `ev` trạm sạc xe điện · `fleet` đội xe GPS |
| (sẵn có) | `solar` năng lượng mặt trời |

Khối giao diện: KPI, đồng hồ vòng, bồn/bể, chip trạng thái, thanh ngang, xu hướng, thẻ theo thiết bị, dây chuyền, vòng OEE, cảnh báo, **mặt bằng (plan), P&ID (pid), lịch tuần (schedule), thang máy (elevator), bản đồ (map), Andon, kế hoạch/thực tế (progress), la bàn gió (wind)**.

### Yêu cầu bắt buộc theo ngành

Mỗi giải pháp khai `required` (chỉ số hoặc `key:<field>`) và lý do (`why`) — xem `tools/solution-kit/requirements.py`. Ví dụ: kho lạnh bắt buộc nhiệt độ; lò hơi bắt buộc mức nước + áp suất + ngọn lửa; đội xe/trạm BTS bắt buộc `lat`/`lon`; thang máy bắt buộc `floor` + `door`. Webapp hiện khung “Thiếu dữ liệu bắt buộc” khi gateway chưa gửi đủ, và liệt kê field cần có ở tab Thiết bị. `solutions/<id>/gateway/setup.json` là bản khai gateway (thiết bị + field + widget) khớp giao diện.

### Kiểm thử

- `cloud/app/scripts/smoke-solutions.js`: cấu trúc mọi giải pháp (spec hợp lệ, tham chiếu chỉ số, `setup.json` qua bộ kiểm tra bản khai, field bắt buộc, engine không lệch bản gốc, bundle ghép đúng).
- `cloud/app/scripts/e2e-solutions.js` (chạy trong container app trên VPS): admin tạo mã → gateway giả ghép cặp bằng `setup.json` → QR → tài khoản `t_<id>` quét → gửi số liệu mẫu → kiểm dashboard/widget, field bắt buộc, bundle, lệnh điều khiển tới gateway. Tài khoản test `t_<id>` đã map sẵn giải pháp.
- **Lưu ý broker:** mỗi lần tạo/thu hồi gateway ghi lại `passwd` và nạp lại Mosquitto. Thu hồi dồn dập (hàng chục lần liên tiếp) từng làm broker thoát — nếu `plciot-mqtt` dừng thì `docker start plciot-mqtt` rồi `docker restart plciot-haproxy` (HAProxy cần nạp lại địa chỉ). Script e2e đã giãn 4 giây giữa các lần thu hồi.

### Một webapp + một gateway dùng chung, giao diện tuỳ biến bằng DỮ LIỆU

Không build riêng từng giải pháp. Mỗi giải pháp là **một thư mục có dấu nhận diện**, trong đó webapp và gateway ở **hai thư mục riêng**:

```
solutions/<id>/
  solution.json   { "kind": "plciot-solution", "title", "themeColor", … }   ← DẤU NHẬN DIỆN (thiếu thì server bỏ qua thư mục)
  webapp/         spec.js (cấu hình giao diện) + theme.css (+ engine industry.js/css); chỉ cần có file
  gateway/        ui.json (giao diện gateway = dữ liệu) + setup.json (bản khai thiết bị/field) [+ solution.json]
```

- **Tự đồng bộ vào ô chọn:** admin đọc `solutions/` từ đĩa (tab Giải pháp tự làm mới 20 giây). Mỗi mục hiện rõ **Webapp ✓/— · Gateway ✓/—**; thiếu phần nào thì mục không hiện ở ô chọn tương ứng (ô của người dùng cần webapp; ô của mã ghép cặp cần gateway). Thư mục thiếu dấu nhận diện hiện ở mục “Bị bỏ qua” kèm lý do.
- **Mapping 1-1 webapp ↔ gateway:** admin chọn giải pháp khi phát mã ghép cặp (hoặc đổi sau ở dòng gateway). Server lưu theo gateway (bảng `gateway_solutions`), trả `solution` + `ui` (nội dung `gateway/ui.json`) trong kit lúc Enroll / cập nhật cấu hình. GatewayApp (một bản duy nhất) lưu `*.skin.json` cạnh file cấu hình và áp dụng khi mở lại — không có file thì là bản cơ bản, đúng như trước. Người dùng quét QR của gateway mà **chưa được đặt giải pháp riêng** → webapp của họ tự map cùng giải pháp (đã đặt rồi thì giữ nguyên).
- **Tuỳ biến giao diện không cần build:** sửa `spec`/`ui.json` (bố cục, chỉ số, ngưỡng, màu, tab) rồi `sync-solutions.ps1`. Nguồn sinh các thư mục này: `tools/solution-kit/` (`python tools/solution-kit/gen.py`).
- **Widget tính từ cảm biến, không qua server:** chỉ số khai `"expr"` được tính ngay trên webapp và gateway từ số cảm biến đã nhận, ví dụ `"expr": "min(pv,load)/pv*100"`, `"pump_kw / flow"`, `"sqrt(kw*kw + kvar*kvar)"`. Tên trong công thức là chỉ số khác, field thô, hoặc `thiết_bị.field`. Cú pháp: số, `+ - * / %`, so sánh, `&& || !`, ngoặc, hàm `min max abs round floor ceil sqrt pow avg sum clamp if coalesce isnull`; thiếu số cảm biến → kết quả rỗng (hiện “—”), chia 0 → rỗng. Bộ tính JS (`tools/solution-kit/expr.js`) và C# (`tools/GatewayApp/Ui/Expr.cs`) dùng chung bộ vector test `tools/solution-kit/expr-vectors.json` (44 ca).
- Ghép cặp QR, `server.json`, MQTT, thiết bị, giao thức, nhật ký, kết nối admin của gateway dùng nguyên mã bản cơ bản; trang giao diện ngành là `tools/GatewayApp/Ui/IndustryPage.cs` (khối: KPI, đồng hồ, bồn, thanh, chip, thẻ thiết bị, dây chuyền, OEE, Andon, kế hoạch, mặt bằng, P&ID, lịch, thang máy, bản đồ, la bàn gió, cảnh báo, xu hướng).
- Kiểm thử: `smoke-solutions.js` (dấu nhận diện, phần webapp/gateway, ui.json khớp spec, công thức hợp lệ, engine không lệch); `e2e-solutions.js` (ghép cặp mang giải pháp, kit có `ui`, user quét QR tự map, dashboard, điều khiển); `dotnet test tools/GatewayApp.Tests` (công thức C# = JS); `--pairtest` + `--demo --shot` với GatewayApp thật trên VPS (Enroll nhận skin, mở lại hiện đúng giao diện).

### Phòng thử với live data thật (PlcSim → gateway → webapp)

`.\tools\solution-kit\lab.ps1 <id>` dựng PlcSim + cấu hình GatewayApp có **đủ field** của giải pháp (thiết bị/field lấy từ `gateway/setup.json`, giá trị sinh theo cùng bộ mẫu của spec: sóng sin, đếm tăng, trạng thái), chạy PlcSim + GatewayApp `--autostart` và đặt giải pháp cho một user (mặc định id 15). Webapp của user nhận live data thật qua Modbus TCP → gateway → cloud, điều khiển công tắc đi ngược lại tới PlcSim. `.\tools\solution-kit\lab.ps1 -Restore` trả PlcSim/gateway về cấu hình gốc (sao lưu ở `%TEMP%\plciot-lab-backup`). Site/Device/MQTT của gateway giữ nguyên.
