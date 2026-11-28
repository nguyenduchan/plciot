# Mẫu thiết bị khởi đầu (RS485)

Nhập trong **GatewayAdmin → 📚 Thiết bị mẫu → ⇩ Nhập JSON**, KIỂM LẠI bảng thanh ghi theo tài liệu của đúng model/phiên bản firmware
của hãng, rồi **💾 Lưu lên server**. Chỉ mẫu đã lưu trên server mới hiện cho kỹ thuật viên (trang cài đặt điện thoại của board Waveshare).

`invt-gd20.json`: đối chiếu GD20 VFD Manual V2.1 (INVT), chương 7 Modbus — lệnh 2000H (1 chạy thuận, 5 dừng), tần số 2001H (0.01 Hz), trạng thái 2100H,
mã lỗi 2102H, số đo 3000H–3007H; mặc định P14.01=4 (19200), P14.02=1 (8E1); đọc tối đa 16 thanh ghi/lần. Đã lưu lên server và thử trọn vòng
(KTV thêm qua LAN → webapp Chạy/Đặt tần số/Dừng) với biến tần giả `tools/gd20_sim.py`, chưa với biến tần thật.
Các file còn lại là bản nháp soạn từ tài liệu công khai — chưa thử trên thiết bị thật. Định dạng: `cloud/app/src/deviceLibrary.js` (`validateTemplate`),
hướng dẫn: `docs/MOBILE-SETUP.md`.
