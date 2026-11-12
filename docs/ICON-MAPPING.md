# Bảng ánh xạ icon ↔ thiết bị công nghiệp (chuẩn)

Nguồn duy nhất: `webapp/icons.js` (`CATALOG`). Xem trực quan: `/icons-preview.html` (chọn kiểu 3D / hiện đại / SCADA, bật/tắt chuyển động).
Icon do dự án tự vẽ (SVG, không phụ thuộc bản quyền bên thứ ba), cùng nét + cùng hiệu ứng để đồng nhất.

## Cách webapp chọn icon cho một thiết bị

1. `icon` do gateway gửi trong `config` (mã dưới đây, a-z0-9_, ≤16 ký tự). C# GatewayApp gửi đúng `Id` của mẫu thiết bị (vd `compressor`, `vfd`, `hvac`).
2. Nếu không có: **loại** thiết bị server (`pump`, `env`, `tank`…; loại chung `dynamic/generic/iot-hub/custom` bị bỏ qua).
3. Nếu vẫn không khớp: **tên / mã** thiết bị (`Bơm tăng áp`, `pump2`, `Quạt hút`…) so với danh sách alias (Anh + Việt, không phân biệt dấu/hoa thường, bỏ số đuôi).
4. Không khớp gì: icon bánh răng chung.

**Một thiết bị = một thẻ = một icon chung** cho mọi widget của nó. Mỗi widget có icon nhỏ riêng mô tả *giá trị* (mức nước → giọt, nhiệt độ → nhiệt kế, tốc độ → kim…) theo khoá field (`level`, `t`, `h`, `flow`, `p`, `speed/rpm`, `kw/v/a`, `hours`, `run/on`, `count`, `ph`, `gas/co2`, `vib`, `weight`, `alarm`, `door`, `batt/soc`).
Nhiều gateway: thiết bị được nhóm theo gateway; gỡ là gỡ cả gateway (webapp).

Hiệu ứng chỉ chạy khi thiết bị đang chạy (khoá `run/q_run/on…` = 1, hoặc có số liệu với cảm biến); tốc độ quay theo khoá `speed/rpm/sp/freq`. Kiểu **SCADA** tắt mọi chuyển động.

| Nhóm | Mã icon | Thiết bị | Hiệu ứng | Alias nhận diện |
|---|---|---|---|---|
| Chất lỏng | `pump` | Bơm | quay + nước chảy | bom, pump, bơm, booster, submersible, bom chim, bơm chìm, bơm tăng áp, dosing, bơm định lượng |
| Chất lỏng | `tank` | Bồn / bể / mức nước | sóng nước | bon, bồn, be, bể, tank, level, muc nuoc, mức nước, reservoir, thung, thùng |
| Chất lỏng | `silo` | Silo / phễu chứa | dòng vật liệu | silo, hopper, phễu, bunker |
| Chất lỏng | `valve` | Van | dòng chảy khi mở | van, valve, solenoid, van điện, van tu, actuator |
| Chất lỏng | `flow` | Lưu lượng kế | sóng chảy | flow, flowmeter, luu luong, lưu lượng |
| Chất lỏng | `pressure` | Áp suất | kim dao động | pressure, ap suat, áp suất, psi, bar, transmitter |
| Chất lỏng | `filter` | Bộ lọc | dòng qua lọc | filter, loc, lọc, ro, strainer |
| Chất lỏng | `mixer` | Máy khuấy / trộn | cánh khuấy quay | mixer, agitator, khuay, khuấy, tron, trộn |
| Chất lỏng | `ph` | pH / chất lượng nước | sóng dung dịch | ph, orp, chlorine, clo, turbidity, do duc, độ đục, chat luong nuoc, chất lượng nước |
| Chuyển động | `motor` | Động cơ | trục quay | motor, dong co, động cơ, engine, servo, spindle |
| Chuyển động | `vfd` | Biến tần | sóng sin chạy | vfd, inverter, bien tan, biến tần, drive, softstarter, khởi động mềm |
| Chuyển động | `fan` | Quạt / quạt thông gió | cánh quay | fan, quat, quạt, blower, exhaust, thông gió, hút gió |
| Chuyển động | `compressor` | Máy nén khí | quay + khí ra | compressor, may nen, máy nén, nén khí, air, vacuum, bơm chân không |
| Chuyển động | `conveyor` | Băng tải | băng chạy | conveyor, bang tai, băng tải, belt, roller, con lăn |
| Chuyển động | `crane` | Cầu trục / palăng | móc nhấp nháy | crane, cau truc, cầu trục, hoist, palang, palăng, lift, thang máy, elevator |
| Chuyển động | `door` | Cửa / cổng | cửa mở | door, gate, cua, cửa, cong, cổng, barrier, shutter, cửa cuốn |
| Nhiệt | `boiler` | Nồi hơi / lò hơi | lửa nhấp nháy | boiler, noi hoi, nồi hơi, lò hơi, steam, furnace, lò, oven |
| Nhiệt | `heater` | Gia nhiệt / điện trở | nhiệt nhấp nháy | heater, gia nhiet, gia nhiệt, dien tro, điện trở, heating |
| Nhiệt | `hvac` | Điều hoà / HVAC | gió thổi | hvac, ac, dieu hoa, điều hoà, điều hòa, air conditioner, ahu, fcu |
| Nhiệt | `chiller` | Chiller / làm lạnh | bông tuyết quay | chiller, cooling, lam lanh, làm lạnh, lạnh, refrigeration, tháp giải nhiệt |
| Nhiệt | `env` | Nhiệt độ | nhấp nháy | env, temp, temperature, nhiet do, nhiệt độ, thermo, thermocouple, pt100, môi trường |
| Nhiệt | `humidity` | Độ ẩm | nhấp nháy | humidity, do am, độ ẩm, hum |
| Điện | `energy` | Đồng hồ điện năng | tia điện | energy, meter, dien nang, điện năng, power, cong suat, công suất, kwh, electric, điện |
| Điện | `generator` | Máy phát điện | quay + điện | generator, may phat, máy phát, genset, alternator |
| Điện | `battery` | Ắc quy / UPS | sạc nhấp nháy | battery, ups, ac quy, ắc quy, pin, accu |
| Điện | `solar` | Điện mặt trời | mặt trời quay | solar, pv, mat troi, mặt trời, inverter solar, điện mặt trời |
| Điện | `transformer` | Máy biến áp | từ thông nhấp nháy | transformer, bien ap, biến áp, mba |
| Điện | `breaker` | Aptomat / tủ điện | tiếp điểm nhấp nháy | breaker, aptomat, mccb, mcb, cb, tu dien, tủ điện, contactor, khởi động từ |
| Điện | `relay` | Rơ-le / công tắc | tiếp điểm đóng | relay, switch, rơ le, rờ le, cong tac, công tắc, role |
| Điện | `bulb` | Đèn chiếu sáng | sáng nhấp nháy | light, bulb, lamp, den, đèn, chieu sang, chiếu sáng |
| Cảm biến | `sensor` | Cảm biến chung | sóng lan | sensor, cam bien, cảm biến, proximity, tiệm cận, detector, radar |
| Cảm biến | `gas` | Khí / khói / CO₂ | khí nhấp nháy | gas, co2, co, smoke, khoi, khói, khí, lpg, air quality, voc |
| Cảm biến | `vibration` | Rung động | sóng rung | vibration, rung, rung động, accelerometer |
| Cảm biến | `scale` | Cân / loadcell | kim cân | scale, weight, loadcell, can, cân, khoi luong, khối lượng |
| Cảm biến | `gauge` | Đồng hồ đo | kim dao động | gauge, dong ho, đồng hồ, speed, rpm, tốc độ |
| An toàn | `alarm` | Cảnh báo / còi | nhấp nháy cảnh báo | alarm, siren, coi, còi, canh bao, cảnh báo, estop, dừng khẩn, horn, beacon |
| Điều khiển | `plc` | PLC / bộ điều khiển | đèn trạng thái | plc, controller, bo dieu khien, bộ điều khiển, hmi, rtu, dcs |
| Điều khiển | `counter` | Bộ đếm / sản lượng | số nhấp nháy | counter, count, dem, đếm, san luong, sản lượng, encoder |
| Điều khiển | `di` | Đầu vào số | tĩnh | di, input, dau vao, đầu vào, button, nut nhan, nút nhấn, limit |
| Điều khiển | `do` | Đầu ra số | tĩnh | do, output, dau ra, đầu ra |
| Điều khiển | `power` | Nguồn / chạy-dừng | tĩnh | run, start, enable, chay, chạy, bat, bật |
| Điều khiển | `clock` | Giờ chạy / thời gian | tĩnh | hours, time, timer, gio chay, giờ chạy, runtime |
| Điều khiển | `gear` | Thiết bị chung / gateway | bánh răng quay | gear, generic, custom, dynamic, iot-hub, gateway, device, thiết bị |
    { id: 3d, name: Đẹp (3D), desc: Icon nổi khối, đổ bóng, có hiệu ứng quay / nước chảy },
    { id: line, name: Hiện đại, desc: Icon nét mảnh, có hiệu ứng chuyển động },
    { id: scada, name: SCADA, desc: Icon tĩnh, phẳng, màu theo trạng thái chạy / dừng },

## Mẫu thiết bị trên GatewayApp (C#)
Mỗi mẫu có `Id` trùng mã icon để webapp vẽ đúng: tank, pump, env, valve, motor, energy, pressure, conveyor, di, do, custom, **fan, compressor, boiler, heater, hvac, chiller, vfd, generator, battery, scale, ph, gas, alarm, door** (xem `tools/GatewayApp/DeviceTemplates.cs`).

## Hai bộ hình dáng

| Kiểu hiển thị | Bộ hình | Nguồn gốc |
|---|---|---|
| Đẹp (3D), Hiện đại | `webapp/icons.js` — hình minh hoạ nét mảnh, bo tròn | Tự vẽ; bố cục theo cách các bộ icon phổ biến (Material Symbols, Tabler, Lucide, Font Awesome) thể hiện bơm / quạt / bồn / van / động cơ: hình khối đơn giản, nét đều, nhận ra ngay ở cỡ nhỏ |
| SCADA | `webapp/icons-pid.js` — ký hiệu P&ID đơn sắc | Tự vẽ theo **thông lệ** ISA-5.1 / ISO 14617 / ISO 10628 / IEC 60617 (bơm = vòng tròn + tam giác, van = hai tam giác chụm đỉnh + màng actuator, "M", "G", bong bóng thiết bị đo T/P/F/AT…) |

Không sao chép tệp / đường vẽ của thư viện hay phần mềm nào (Icons8, Ignition, WinCC, Wonderware… có giấy phép riêng). Hình dáng chuẩn hoá (ký hiệu P&ID) là thông lệ kỹ thuật dùng chung; nét vẽ cụ thể ở đây là của dự án.
**Cần đối chiếu** với bảng ký hiệu (legend) chính thức của ISA-5.1 / ISO 10628 trước khi dùng cho bản vẽ có giá trị pháp lý; nhà phát triển chưa có bản chuẩn trả phí để so từng nét.
