# solutions/ — thư mục chuẩn đồng bộ PC ↔ VPS

| Máy | Đường dẫn |
|---|---|
| PC lập trình | `<repo>/solutions/` |
| VPS | `/root/plciot/solutions/` (container gắn `/app/solutions`, chỉ đọc) |

Mỗi giải pháp là một thư mục con `solutions/<id>/` (id: chữ thường/số/`_`, bắt đầu bằng chữ). Thư mục bắt đầu bằng `_` (như `_template`) bị bỏ qua.

```
solutions/<id>/
  solution.json   { "kind": "plciot-solution", "title": "…", … }   ← DẤU NHẬN DIỆN: thiếu thì server bỏ qua thư mục
  webapp/         giao diện webapp (spec.js + theme.css + engine, hoặc file riêng)
  gateway/        giao diện gateway: ui.json (dữ liệu) + setup.json (bản khai)
```

Webapp và gateway ở hai thư mục riêng; giải pháp có thể chỉ có một trong hai. Admin tự nhận mọi thư mục có dấu nhận diện và hiện rõ phần nào có (Webapp ✓ · Gateway ✓).

## Thêm giải pháp mới

1. `Copy-Item solutions\_template solutions\<id> -Recurse`, sửa `solution.json` (giữ `kind`), thêm file vào `webapp/` và/hoặc `gateway/`. Giải pháp ngành có sẵn sinh bằng `python tools/solution-kit/gen.py`.
2. `.\cloud\scripts\sync-solutions.ps1` — chỉ chép `solutions/` lên VPS (không build, không khởi động lại).
3. Admin → tab **Giải pháp** tự có mục (mã = tên thư mục, làm mới mỗi 20 giây). Tab chỉ để đổi tên, ẩn, hoặc thêm mục tên khác trỏ cùng thư mục.
4. Gán cho người dùng ở tab **Người dùng**, hoặc chọn khi phát mã ghép cặp gateway (gateway + webapp của người quét QR dùng cùng giải pháp).

## Icon (webapp + gateway dùng chung)

Nguồn duy nhất `tools/solution-kit/icons.json`: bộ icon đại lượng đo (nét 24×24) + luật chọn icon theo đơn vị / nhãn / khoá field (°C → nhiệt kế, bar → đồng hồ áp, %RH → giọt ẩm, Chạy/Dừng của bơm → bơm…). `gen.py` sinh `webapp/metric-icons.js` (gộp cả vào `industry-engine.js`) và `tools/GatewayApp/Ui/IconData.g.cs`; icon thiết bị của gateway lấy nguyên từ `webapp/icons.js`. Chỉ số có thể đặt `"icon": "<mã>"` để chọn tay. Sửa luật xong chạy lại `gen.py`, rồi kiểm tra: `node tools/solution-kit/test-icons.js` và `dotnet test tools/GatewayApp.Tests`. Xem thử webapp không cần đăng nhập: `tools/solution-kit/ind-preview.html?id=<giải pháp>`; gateway: `GatewayApp.exe --iconsheet icons.png`, `--demo --solshot THƯ_MỤC`.

Chi tiết: `docs/SOLUTIONS.md`.
